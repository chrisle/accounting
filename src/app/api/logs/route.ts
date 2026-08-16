import { NextResponse } from 'next/server'
import { recentLogs, type LogLevel } from '@/lib/logs'

export const dynamic = 'force-dynamic'

const LEVELS = new Set(['info', 'warn', 'error'])

export async function GET(req: Request) {
  const level = new URL(req.url).searchParams.get('level')
  const filter = level && LEVELS.has(level) ? (level as LogLevel) : undefined
  return NextResponse.json(await recentLogs(500, filter))
}
