import assert from 'node:assert/strict'
import { test, describe } from 'node:test'
import { normalizeMerchant } from '../src/lib/attribution/rules'
import { merchantFingerprint } from '../src/lib/attribution/overrides'

/**
 * normalizeMerchant feeds two things that both break quietly when it is wrong:
 * rules regex against its output, and the `merchant:` override fingerprint
 * hashes it. The id-stripping rule used to match any 10+ character alphanumeric
 * run, which blanked ordinary one-word merchants — so "cloudflare" matched no
 * rule and shared a fingerprint with "squarespace".
 */
describe('normalizeMerchant', () => {
  test('keeps one-word merchants of 10+ characters', () => {
    for (const name of [
      'Cloudflare',
      'Squarespace',
      'Digitalocean',
      'Shutterstock',
      'Youtubepremium',
      'Soundswitch',
    ]) {
      assert.equal(normalizeMerchant(name), name.toLowerCase(), `${name} was mangled`)
    }
  })

  test('still strips order and auth ids, which contain digits', () => {
    assert.equal(normalizeMerchant('Acme Corp 4G82HN3K9Q1'), 'acme corp')
    assert.equal(normalizeMerchant('Store 123-4567890-1234567'), 'store')
  })

  test('keeps merchants whose name legitimately contains digits', () => {
    assert.equal(normalizeMerchant('1Password'), '1password')
    assert.equal(normalizeMerchant('7-Eleven'), '7-eleven')
  })

  test('collapses Amazon per-order tokens to a stable merchant', () => {
    const a = normalizeMerchant('AMZN Mktp US*2H4XY9')
    const b = normalizeMerchant('AMZN Mktp US*RT4G82HN3')
    assert.equal(a, 'amzn mktp')
    assert.equal(a, b, 'two Amazon charges must share one merchant identity')
  })

  test('strips the processor prefix, not the merchant after it', () => {
    assert.equal(normalizeMerchant('SQ *BLUE BOTTLE COFFEE'), 'blue bottle coffee')
    assert.equal(normalizeMerchant('PAYPAL *FIGMA INC'), 'figma inc')
  })

  test('never returns an empty string', () => {
    for (const junk of ['##########', '**********', '1234567890123', '   ', '']) {
      assert.ok(normalizeMerchant(junk).length > 0, `${JSON.stringify(junk)} normalised to empty`)
    }
  })

  test('distinct merchants keep distinct fingerprints', () => {
    const names = ['Cloudflare', 'Squarespace', 'Digitalocean', 'Shutterstock', 'Youtubepremium']
    const fps = new Set(names.map((n) => merchantFingerprint(normalizeMerchant(n))))
    assert.equal(fps.size, names.length, 'an override on one would hit the others')
  })
})
