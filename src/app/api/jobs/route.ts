import { NextResponse } from 'next/server'
import { recentJobs } from '@/lib/jobs/queue'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(await recentJobs(15))
}
