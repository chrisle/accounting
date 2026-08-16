import type { Metadata } from 'next'
import Link from 'next/link'
import './globals.css'
import { ThemeToggle } from '@/components/theme-toggle'

export const metadata: Metadata = {
  title: 'Costs',
  description: 'Project cost attribution across Copilot, Amazon and Google Cloud',
}

const NAV = [
  { href: '/', label: 'Overview' },
  { href: '/projects', label: 'Projects' },
  { href: '/review', label: 'Review' },
  { href: '/sources', label: 'Sources' },
  { href: '/rules', label: 'Rules' },
  { href: '/logs', label: 'Logs' },
]

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Set the theme before first paint so dark mode never flashes white. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(()=>{try{const t=localStorage.getItem('theme');if(t)document.documentElement.dataset.theme=t}catch(e){}})()`,
          }}
        />
      </head>
      <body className="min-h-screen">
        <header className="border-b border-line bg-surface-1">
          <div className="mx-auto flex max-w-[1400px] items-center gap-1 px-6 py-3">
            <Link href="/" className="mr-5 flex items-center gap-2 font-semibold">
              <span
                aria-hidden
                className="inline-block size-3 rounded-[3px]"
                style={{ background: 'var(--text-primary)' }}
              />
              Costs
            </Link>
            <nav className="flex items-center gap-1">
              {NAV.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  className="rounded-md px-3 py-1.5 text-sm text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
                >
                  {n.label}
                </Link>
              ))}
            </nav>
            <div className="ml-auto">
              <ThemeToggle />
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-[1400px] px-6 py-7">{children}</main>
      </body>
    </html>
  )
}
