// Picking one of two regenerated variants ("תן לי שתי אפשרויות לשקופית 2"): swaps the chosen picture into every
// draft of the run and updates the shared content item. Server-only (used by the webhook's pick: buttons).
import { getItem, upsertItem, addNote } from './contentItems.js'
import { replaceRunAsset } from './releaseGate.js'

export async function applyPickedVariant(runId, n) {
  const item = await getItem(runId)
  const pv = item?.media?.pending_variants
  if (!item || !pv) return { ok: false, reason: 'אין אפשרויות ממתינות לבחירה' }
  const media = { ...item.media }
  delete media.pending_variants
  if (n === 0) {
    await upsertItem(runId, { media })
    await addNote(runId, `kept the original picture ${pv.slide + 1}`)
    return { ok: true, kept: true, slide: pv.slide }
  }
  const url = pv.urls[n - 1]
  const images = [...(item.media.images || [])]
  const old = images[pv.slide]
  if (!url || !old) return { ok: false, reason: 'האפשרות שנבחרה לא נמצאה' }
  const changed = await replaceRunAsset(runId, old, url)
  images[pv.slide] = url
  const plan = { ...(item.plan || {}) }
  if (plan.carousel_prompts?.length) plan.carousel_prompts = plan.carousel_prompts.map((p, i) => (i === pv.slide ? pv.prompt : p))
  if (pv.slide === 0) plan.generation_prompt = pv.prompt
  await upsertItem(runId, { media: { ...media, images, image: images[0] }, plan })
  await addNote(runId, `picture ${pv.slide + 1}: variant ${n} chosen (${changed} posts updated)`, 'generator')
  return { ok: true, slide: pv.slide, changed }
}
