import { NextResponse } from 'next/server'
import { ingestUpload } from '@/lib/sources/amazon'
import { enqueue } from '@/lib/jobs/queue'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * Amazon's "Request My Data" archive lands here. Parsing happens inline so the
 * user gets an immediate, specific error if they uploaded the wrong ZIP; the
 * database write and re-attribution are queued so the request returns fast.
 */
export async function POST(req: Request) {
  try {
    const form = await req.formData()
    const file = form.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }
    if (file.size > 512 * 1024 * 1024) {
      return NextResponse.json({ error: 'File larger than 512 MB' }, { status: 413 })
    }

    const bytes = Buffer.from(await file.arrayBuffer())
    const lines: string[] = []
    const { items, storedPath, hash } = await ingestUpload(
      file.name,
      bytes,
      (m) => lines.push(m),
    )

    if (items.length === 0) {
      return NextResponse.json(
        { error: 'Parsed the file but found no order rows in it.' },
        { status: 422 },
      )
    }

    await enqueue('ingest:amazon', {
      items,
      storedPath,
      hash,
      filename: file.name,
    })
    await enqueue('link')
    await enqueue('attribute')

    return NextResponse.json({ ok: true, items: items.length, log: lines })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    )
  }
}
