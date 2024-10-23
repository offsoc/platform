//
// Copyright © 2024 Hardcore Engineering Inc.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
//

import { type MeasureContext, type WorkspaceId, concatLink } from '@hcengineering/core'
import FormData from 'form-data'
import fetch, { type RequestInit, type Response } from 'node-fetch'
import { Readable } from 'stream'

/** @public */
export interface ObjectMetadata {
  lastModified: number
  name: string
  type: string
  size?: number
}

/** @public */
export interface StatObjectOutput {
  lastModified: number
  type: string
  etag?: string
  size?: number
}

interface BlobUploadError {
  key: string
  error: string
}

interface BlobUploadSuccess {
  key: string
  id: string
  metadata: ObjectMetadata
}

type BlobUploadResult = BlobUploadSuccess | BlobUploadError

/** @public */
export class Client {
  constructor (private readonly endpoint: string) {}

  getObjectUrl (ctx: MeasureContext, workspace: WorkspaceId, objectName: string): string {
    const path = `/blob/${workspace.name}/${encodeURIComponent(objectName)}`
    return concatLink(this.endpoint, path)
  }

  async getObject (ctx: MeasureContext, workspace: WorkspaceId, objectName: string): Promise<Readable> {
    const url = this.getObjectUrl(ctx, workspace, objectName)

    let response
    try {
      response = await fetchSafe(ctx, url)
    } catch (err) {
      console.error('failed to get object', { workspace, objectName, err })
      throw err
    }

    if (response.body == null) {
      ctx.error('bad datalake response', { objectName })
      throw new Error('Missing response body')
    }

    return Readable.from(response.body)
  }

  async getPartialObject (
    ctx: MeasureContext,
    workspace: WorkspaceId,
    objectName: string,
    offset: number,
    length?: number
  ): Promise<Readable> {
    const url = this.getObjectUrl(ctx, workspace, objectName)
    const headers = {
      Range: length !== undefined ? `bytes=${offset}-${offset + length - 1}` : `bytes=${offset}`
    }

    let response
    try {
      response = await fetchSafe(ctx, url, { headers })
    } catch (err) {
      console.error('failed to get partial object', { workspace, objectName, err })
      throw err
    }

    if (response.body == null) {
      ctx.error('bad datalake response', { objectName })
      throw new Error('Missing response body')
    }

    return Readable.from(response.body)
  }

  async statObject (
    ctx: MeasureContext,
    workspace: WorkspaceId,
    objectName: string
  ): Promise<StatObjectOutput | undefined> {
    const url = this.getObjectUrl(ctx, workspace, objectName)

    let response: Response
    try {
      response = await fetchSafe(ctx, url, { method: 'HEAD' })
    } catch (err) {
      console.error('failed to stat object', { workspace, objectName, err })
      throw err
    }

    const headers = response.headers
    const lastModified = Date.parse(headers.get('Last-Modified') ?? '')
    const size = parseInt(headers.get('Content-Length') ?? '0', 10)

    return {
      lastModified: isNaN(lastModified) ? 0 : lastModified,
      size: isNaN(size) ? 0 : size,
      type: headers.get('Content-Type') ?? '',
      etag: headers.get('ETag') ?? ''
    }
  }

  async deleteObject (ctx: MeasureContext, workspace: WorkspaceId, objectName: string): Promise<void> {
    const url = this.getObjectUrl(ctx, workspace, objectName)
    try {
      await fetchSafe(ctx, url, { method: 'DELETE' })
    } catch (err) {
      console.error('failed to delete object', { workspace, objectName, err })
      throw err
    }
  }

  async putObject (
    ctx: MeasureContext,
    workspace: WorkspaceId,
    objectName: string,
    stream: Readable | Buffer | string,
    metadata: ObjectMetadata,
    size?: number
  ): Promise<void> {
    if (size === undefined) {
      if (Buffer.isBuffer(stream)) {
        size = stream.length
      } else if (typeof stream === 'string') {
        size = Buffer.byteLength(stream)
      } else {
        // TODO: Implement size calculation for Readable streams
        ctx.warn('unknown object size', { workspace, objectName })
      }
    }

    try {
      if (size === undefined || size < 64 * 1024 * 1024) {
        await ctx.with('direct-upload', {}, async (ctx) => {
          await this.uploadWithFormData(ctx, workspace, objectName, stream, metadata)
        })
      } else {
        await ctx.with('signed-url-upload', {}, async (ctx) => {
          await this.uploadWithSignedURL(ctx, workspace, objectName, stream, metadata)
        })
      }
    } catch (err) {
      console.error('failed to put object', { workspace, objectName, err })
      throw err
    }
  }

  private async uploadWithFormData (
    ctx: MeasureContext,
    workspace: WorkspaceId,
    objectName: string,
    stream: Readable | Buffer | string,
    metadata: ObjectMetadata
  ): Promise<void> {
    const path = `/upload/form-data/${workspace.name}`
    const url = concatLink(this.endpoint, path)

    const form = new FormData()
    const options: FormData.AppendOptions = {
      filename: encodeURIComponent(objectName),
      contentType: metadata.type,
      knownLength: metadata.size,
      header: {
        'Last-Modified': metadata.lastModified
      }
    }
    form.append('file', stream, options)

    const response = await fetchSafe(ctx, url, { method: 'POST', body: form })

    const result = (await response.json()) as BlobUploadResult[]
    if (result.length !== 1) {
      throw new Error('Bad datalake response: ' + result.toString())
    }

    const uploadResult = result[0]

    if ('error' in uploadResult) {
      throw new Error('Upload failed: ' + uploadResult.error)
    }
  }

  private async uploadWithSignedURL (
    ctx: MeasureContext,
    workspace: WorkspaceId,
    objectName: string,
    stream: Readable | Buffer | string,
    metadata: ObjectMetadata
  ): Promise<void> {
    const url = await this.signObjectSign(ctx, workspace, objectName)

    try {
      await fetchSafe(ctx, url, {
        body: stream,
        method: 'PUT',
        headers: {
          'Content-Type': metadata.type,
          'Content-Length': metadata.size?.toString() ?? '0',
          'x-amz-meta-last-modified': metadata.lastModified.toString()
        }
      })
    } catch (err) {
      await this.signObjectDelete(ctx, workspace, objectName)
      throw new Error('Failed to upload via signed URL')
    }

    await this.signObjectComplete(ctx, workspace, objectName)
  }

  private async signObjectSign (ctx: MeasureContext, workspace: WorkspaceId, objectName: string): Promise<string> {
    try {
      const url = this.getSignObjectUrl(workspace, objectName)
      const response = await fetchSafe(ctx, url, { method: 'POST' })
      return await response.text()
    } catch (err: any) {
      ctx.error('failed to sign object', { workspace, objectName, err })
      throw new Error('Failed to sign URL')
    }
  }

  private async signObjectComplete (ctx: MeasureContext, workspace: WorkspaceId, objectName: string): Promise<void> {
    try {
      const url = this.getSignObjectUrl(workspace, objectName)
      await fetchSafe(ctx, url, { method: 'PUT' })
    } catch (err: any) {
      ctx.error('failed to complete signed url upload', { workspace, objectName, err })
      throw new Error('Failed to complete signed URL upload')
    }
  }

  private async signObjectDelete (ctx: MeasureContext, workspace: WorkspaceId, objectName: string): Promise<void> {
    try {
      const url = this.getSignObjectUrl(workspace, objectName)
      await fetchSafe(ctx, url, { method: 'DELETE' })
    } catch (err: any) {
      ctx.error('failed to abort signed url upload', { workspace, objectName, err })
      throw new Error('Failed to abort signed URL upload')
    }
  }

  private getSignObjectUrl (workspace: WorkspaceId, objectName: string): string {
    const path = `/upload/signed-url/${workspace.name}/${encodeURIComponent(objectName)}`
    return concatLink(this.endpoint, path)
  }
}

async function fetchSafe (ctx: MeasureContext, url: string, init?: RequestInit): Promise<Response> {
  let response
  try {
    response = await fetch(url, init)
  } catch (err: any) {
    ctx.error('network error', { err })
    throw new Error(`Network error ${err}`)
  }

  if (!response.ok) {
    const text = await response.text()
    throw new Error(response.status === 404 ? 'Not Found' : 'HTTP error ' + response.status + ': ' + text)
  }

  return response
}
