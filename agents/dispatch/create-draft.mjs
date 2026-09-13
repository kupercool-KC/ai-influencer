// Creates a DRAFT post in Buffer (never auto-published) for one channel, with an
// image and caption. The human reviews and publishes it manually inside Buffer —
// matches the "upload manually for now" decision. Once ready to automate, flip
// saveToDraft to false / add scheduling here.
//
// Usage: node create-draft.mjs --channel <channelId> --image <url> --text "<caption>"
//
// Requires BUFFER_API_KEY in the environment.

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

async function main() {
  const { channel, image, text } = parseArgs(process.argv.slice(2))
  if (!channel || !image || !text) {
    console.error('Usage: node create-draft.mjs --channel <channelId> --image <url> --text "<caption>"')
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
  const variables = {
    input: {
      text,
      channelId: channel,
      schedulingType: 'automatic',
      mode: 'addToQueue',
      saveToDraft: true,
      assets: [{ image: { url: image } }],
    },
  }

  const data = await bufferQuery(mutation, variables)
  const result = data.createPost
  if (result.message) {
    console.error('Buffer error:', result.message)
    process.exit(1)
  }
  console.log(`Draft created: post id ${result.post.id}`)
}

main().catch(e => { console.error(e.message); process.exit(1) })
