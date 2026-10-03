// Creates a DRAFT post in Buffer (never auto-published) for one channel, with an
// image and caption. The human reviews and publishes it manually inside Buffer —
// matches the "upload manually for now" decision. Once ready to automate, flip
// saveToDraft to false / add scheduling here.
//
// Usage: node create-draft.mjs --channel <channelId> --image <url> --text "<caption>"
//   [--platform tiktok|instagram|youtube|facebook] [--influencer <id>] [--media-asset <uuid>]
//   [--post-type post|story|reel]  (story/reel are Instagram-only; ignored/invalid for other platforms)
//   [--video <url>]  (use INSTEAD of --image to queue a video: Instagram Reel or TikTok video)
//   [--audio-mood "<vibe words>"]  (Instagram Stories only — see pickInstagramAudio below)
//   [--run-id <id>] [--scheduled-for <iso8601>]  (recorded on the scheduled_dispatches row —
//   run-id groups one day's drafts for the Telegram "Approve" button in api/telegram/webhook.js;
//   scheduled-for is OUR intended send time, not yet applied to Buffer — the draft stays a plain
//   draft until approved, at which point the webhook re-submits it with this as its real dueAt)
//
// Requires BUFFER_API_KEY in the environment. If SUPABASE_URL +
// SUPABASE_SERVICE_ROLE_KEY are also set, records the draft as a row in
// scheduled_dispatches (skipped silently otherwise).
//
// Music (2026-09-30, researched — see docs/video-prompt-spec.md §11): Buffer's GraphQL API
// exposes real Instagram trending-audio search (searchInstagramAudio/trendingInstagramAudio)
// and an InstagramStickerFields.music field, so a real trending/mood-matched track CAN be
// attached automatically to an Instagram Story — this is not possible for TikTok, whose
// Content Posting API does not accept a sound selection from third-party tools at all (a real
// platform restriction, confirmed via web research, not something this code can route around).

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '')
    out[key] = argv[i + 1]
  }
  return out
}

async function bufferQuery(query, variables) {
  const apiKey = process.env.BUFFER_API_KEY
  if (!apiKey) throw new Error('Missing BUFFER_API_KEY env var')

  const r = await fetch('https://api.buffer.com', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, variables }),
  })
  const data = await r.json()
  if (data.errors) throw new Error(data.errors.map(e => e.message).join('; '))
  return data.data
}

async function pickInstagramAudio(channelId, mood) {
  const AUDIO_FRAGMENT = `
    ... on SearchInstagramAudioSuccess { audio { id title displayArtist } }
    ... on ChannelRefreshRequired { message }
  `
  if (mood) {
    try {
      const data = await bufferQuery(
        `query($input: SearchInstagramAudioInput!) { searchInstagramAudio(input: $input) { ${AUDIO_FRAGMENT} } }`,
        { input: { channelId, audioType: 'music', query: mood } },
      )
      const hit = data.searchInstagramAudio?.audio?.[0]
      if (hit) return hit
    } catch (e) {
      console.error(`Warning: Instagram audio search failed (${e.message}), falling back to trending`)
    }
  }
  try {
    const data = await bufferQuery(
      `query($input: TrendingInstagramAudioInput!) { trendingInstagramAudio(input: $input) { ${AUDIO_FRAGMENT} } }`,
      { input: { channelId, audioType: 'music' } },
    )
    return data.trendingInstagramAudio?.audio?.[0] || null
  } catch (e) {
    console.error(`Warning: Instagram trending audio fetch failed (${e.message}), posting without music`)
    return null
  }
}

async function recordDispatch({ influencerId, mediaAssetId, platform, bufferPostId, runId, scheduledFor }) {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key || !platform) return // optional — skip quietly if not configured

  await fetch(`${url}/rest/v1/scheduled_dispatches`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({
      influencer_id: influencerId || null,
      media_asset_id: mediaAssetId || null,
      platform,
      buffer_post_id: bufferPostId,
      run_id: runId || null,
      scheduled_for: scheduledFor || null,
      status: 'pending', // it's a draft in Buffer, not yet published
    }),
  }).catch(e => console.error('Warning: failed to record scheduled_dispatch:', e.message))
}

async function main() {
  const {
    channel, image, video, text, platform, influencer: influencerId, 'media-asset': mediaAssetId,
    'post-type': postType = video && platform === 'instagram' ? 'reel' : 'post', 'audio-mood': audioMood,
    'run-id': runId, 'scheduled-for': scheduledFor,
  } = parseArgs(process.argv.slice(2))
  if (!channel || !(image || video) || !text) {
    console.error('Usage: node create-draft.mjs --channel <channelId> (--image <url> | --video <url>) --text "<caption>"')
    process.exit(1)
  }
  if ((postType === 'story' || postType === 'reel') && platform !== 'instagram') {
    console.error(`--post-type ${postType} is Instagram-only, got platform "${platform}"`)
    process.exit(1)
  }

  const mutation = `
    mutation CreateDraftPost($input: CreatePostInput!) {
      createPost(input: $input) {
        ... on PostActionSuccess {
          post { id text }
        }
        ... on MutationError {
          message
        }
      }
    }
  `
  // Instagram's Buffer API requires metadata.instagram.type + shouldShareToFeed on every
  // post (confirmed via the Buffer MCP's introspect_schema — "Invalid post: Instagram
  // posts require a type" otherwise). A plain feed image is type "post"; a Story is type
  // "story" and must NOT also share to the feed. TikTok has no such required metadata.
  let instagramMeta = postType === 'story' ? { type: 'story', shouldShareToFeed: false } : { type: postType, shouldShareToFeed: true }
  if (platform === 'instagram' && postType === 'story') {
    // Stories have no caption field in the app — the only on-screen text is the
    // text sticker, set here via stickerFields.text. Buffer's top-level `text`
    // on a Story post is just Buffer's own record of what was asked for; it is
    // never rendered on the image itself (confirmed via a live post: text stuck
    // at "" / null on-screen until this was added).
    let stickerFields = { text }
    const audio = await pickInstagramAudio(channel, audioMood)
    if (audio) {
      console.log(`Attaching Instagram audio: "${audio.title}" — ${audio.displayArtist || 'unknown artist'} (id ${audio.id})`)
      stickerFields = { ...stickerFields, music: audio.id }
    } else {
      console.log('No Instagram audio found/attached for this story (posting without music).')
    }
    instagramMeta = { ...instagramMeta, stickerFields }
  }
  const metadata = platform === 'instagram' ? { instagram: instagramMeta } : undefined

  const variables = {
    input: {
      text,
      channelId: channel,
      schedulingType: 'automatic',
      mode: 'addToQueue',
      saveToDraft: true,
      assets: [video ? { video: { url: video } } : { image: { url: image } }],
      ...(metadata ? { metadata } : {}),
    },
  }

  const data = await bufferQuery(mutation, variables)
  const result = data.createPost
  if (result.message) {
    console.error('Buffer error:', result.message)
    process.exit(1)
  }
  console.log(`Draft created: post id ${result.post.id}`)
  await recordDispatch({ influencerId, mediaAssetId, platform, bufferPostId: result.post.id, runId, scheduledFor })
}

main().catch(e => { console.error(e.message); process.exit(1) })
