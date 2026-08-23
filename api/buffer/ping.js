// Health check: confirms BUFFER_API_KEY actually works and shows which
// channels are connected. Visit /api/buffer/ping to verify.

import { bufferQuery } from '../../lib/bufferClient.js'

export default async function handler(req, res) {
  try {
    const orgData = await bufferQuery(`
      query GetOrganizations {
        account { organizations { id name } }
      }
    `)
    const org = orgData.account.organizations[0]
    if (!org) return res.status(200).json({ ok: true, organization: null, channels: [] })

    const channelData = await bufferQuery(`
      query GetChannels($organizationId: String!) {
        channels(input: { organizationId: $organizationId }) {
          id name displayName service isQueuePaused
        }
      }
    `, { organizationId: org.id })

    return res.status(200).json({
      ok: true,
      organization: org,
      channels: channelData.channels,
    })
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message })
  }
}
