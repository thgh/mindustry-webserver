// FROM alpine:latest

// ARG tag_name

// ENV \
//     CONFIG=/opt/mindustry/config

// RUN \
//     apk add --no-cache openjdk8-jre shadow  && \
//     mkdir -p /opt/mindustry && \
//     mkdir -p /opt/mindustry/config && \
//     useradd -u 999 -U -s /bin/false sheep && \
//     groupmod -o -g 1000 sheep && \
//     usermod -G sheep sheep && \
//     chown sheep:sheep -R /opt/mindustry/config && \
//     wget https://github.com/Anuken/Mindustry/releases/download/${tag_name}/server-release.jar -O /opt/mindustry/server-release.jar

// COPY docker-entrypoint.sh /

// VOLUME /opt/mindustry/config

// EXPOSE 6567
// EXPOSE 6859

// ENTRYPOINT ["/docker-entrypoint.sh"]
import { $, type ServerWebSocket, type Subprocess } from 'bun'

const sockets = new Set<ServerWebSocket<unknown>>()
const port = parseInt(process.env['PORT']!) || 6543
const password = process.env['PASSWORD'] || random()
console.log('📦 Mindustry server password is', password)
Bun.serve({
  port,
  async fetch(req, server) {
    const authorization = req.headers.get('Authorization')
    const data = { authorization }
    if (server.upgrade(req, { data })) return

    const url = new URL(req.url)
    if (!url.pathname.startsWith('/api')) {
      const index = await $`cat index.html`.text()
      return new Response(index, {
        headers: { 'content-type': 'text/html' },
      })
    }

    // basic auth
    const auth = req.headers.get('authorization')
    if (auth?.startsWith('Basic ')) {
      const [user, pass] = atob(auth.slice(6)).split(':')
      if (user === 'admin' && pass === 'admin') {
        return Response.json({ message: 'Authenticated' })
      }
      return Response.json({ message: 'Unauthorized' }, { status: 401 })
    }

    const cmd = url.searchParams.get('cmd')

    if (cmd === 'reset') return reset()
    if (cmd === 'start') return start()
    if (cmd === 'stop') return stop()

    if (cmd) return command(cmd)

    console.log('📦 ' + url.pathname)

    return Response.json({ message: 'Hello, world!' })
  },
  websocket: {
    open(ws) {
      sockets.add(ws)
      ws.sendText(
        JSON.stringify(
          Object.fromEntries(
            Object.entries(state).filter(([k]) => interesting.includes(k))
          )
        )
      )

      if (state.status === 'init') {
        console.log('📦 Initialize server')
        start()
      }
    },
    // this is called when a message is received
    async message(ws, message) {
      console.log('📦 ' + `Received ${message}`)
    },
  },
})
console.log('📦 Listening on http://localhost:' + port)

const _state = {
  status: 'init',
  host: 'stopped',
  paused: 'off',
  recentOutput: '',
  log: '',
} as {
  status: 'init' | 'starting' | 'started' | 'stopping' | 'stopped'
  host: 'started' | 'starting' | 'stopped'
  paused?: 'on' | 'off'
  gameover?: string
  map?: string
  wave?: number
  connectedPlayers?: number
  nextmap?: string
  process?: Subprocess<'pipe', 'pipe', 'pipe'>
  recentOutput: string
  log: string
}
const interesting = [
  'status',
  'log',
  'host',
  'paused',
  'map',
  'nextmap',
  'game',
  'wave',
  'connectedPlayers',
]
const state = new Proxy(_state, {
  set(target, prop, value) {
    if (interesting.includes(prop as string)) {
      sockets.forEach((ws) => ws.sendText(JSON.stringify({ [prop]: value })))
    }
    // @ts-expect-error
    target[prop] = value
    return true
  },
})

async function command(cmd: string) {
  if (state.status !== 'started') {
    state.log += '🔴 Ignored ' + cmd + '\n'
    return Response.json({ message: 'Server is not started' })
  }

  state.log += '> ' + cmd + '\n'

  state.process?.stdin.write(cmd + '\n')
  let timeout = 10
  while (true) {
    if (state.recentOutput.length) break
    if (timeout > 1000) return Response.json({ message: 'Timeout' })
    timeout *= 2
    // console.log('📦 timeout', timeout)
    await new Promise((resolve) => setTimeout(resolve, timeout))
  }

  const text = state.recentOutput
  state.recentOutput = ''

  return Response.json({ message: text })
}

async function start() {
  state.log += '> start\n'
  if (state.status === 'starting')
    return Response.json({ message: 'Already starting' })
  if (state.status === 'started')
    return Response.json({ message: 'Already started' })
  if (state.status === 'stopping')
    return Response.json({ message: 'Wait for stopping' })

  let resolveLoaded = () => console.log('📦 resolveLoaded.error')
  const loaded = new Promise<void>((resolve) => {
    resolveLoaded = resolve
  })

  state.status = 'starting'

  await prepare()

  const childProc = Bun.spawn(['/usr/bin/java', '-jar', 'server-release.jar'], {
    ipc() {
      console.log('📦 ipc')
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  state.process = childProc

  // Get a reader for stdout
  const reader = childProc.stdout.getReader()

  // Function to read data from the reader
  const readData = async () => {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }
        const colored = new TextDecoder().decode(value)
        const text = removeShellColors(colored)
        if (text.includes('Server loaded.')) {
          console.log('🟢 Ready to play')
          resolveLoaded()
        }
        interpret(text)

        state.recentOutput += text
        state.log += text
        // Assuming the server sends the status in a particular format
        process.stdout.write('📦 ' + colored)
      }
    } catch (error) {
      console.error(`Error reading from child process: ${error}`)
    }
    console.log('🔴 done reading stdout')
    state.status = 'stopped'
    state.host = 'stopped'
  }

  // Start reading data
  readData()

  await loaded
  state.status = 'started'
  return Response.json({ message: 'Started' })
}

function interpret(text: string) {
  if (text.includes('\n')) return text.split('\n').forEach(interpret)
  if (!text.trim()) return

  if (text.includes('> - ') || text.includes('] - ')) return

  // Randomized next map to be Fortress.
  if (text.includes('Randomized next map to be')) {
    const map = text.split('Randomized next map to be')[1].split('.')[0].trim()
    state.nextmap = map
  } else if (text.includes('Next map is')) {
    const map = text.split('Next map is ')[1].split('.')[0]
    state.nextmap = map
    // Loading map...
    // Map loaded.
  } else if (text.includes('Loading map...')) {
    state.map = state.nextmap
    state.nextmap = ''
    // Opened a server on port 6567.
  } else if (text.includes('Opened a server on port')) {
    state.host = 'started'
    // Stopped server.
  } else if (text.includes('Stopped server.')) {
    state.host = 'stopped'
    // Game paused.
    // Game unpaused.
  } else if (text.includes('Game paused.')) {
    state.paused = 'on'
  } else if (text.includes('Game unpaused.')) {
    state.paused = 'off'
    // Next map set to 'Fork'.
  } else if (text.includes("Next map set to '")) {
    const map = /Next map set to '(.*)'./.exec(text)![1]
    state.nextmap = map.trim()

    // Status:
    // Playing on map Domain / Wave 1
    // 245 seconds until next wave.
    // 0 units / 0 enemies
    // 61 FPS, 28 MB used.
  } else if (text.includes('Playing on map')) {
    state.map = text.split('Playing on map ')[1].split(' /')[0]
    state.wave = parseInt(text.split('Wave ')[1].split('\n')[0])
    // No players connected.
  } else if (text.includes('No players connected.')) {
    state.connectedPlayers = 0

    // Game over! Reached wave 3 with 0 players online on map Domain.
    // Selected next map to be Fork.
  } else if (text.includes('Game over! Reached wave')) {
    state.gameover = new Date().toJSON()
  } else if (text.includes('next map to be ')) {
    state.nextmap = text.split('next map to be ')[1].split('.')[0]

    // Thomas has connected. [ju80gVo2f9IAAAAAgTriww==]
  } else if (text.includes('has connected.')) {
    state.connectedPlayers = (state.connectedPlayers || 0) + 1
    // Thomas has disconnected. [ju80gVo2f9IAAAAAgTriww==]
  } else if (text.includes('has disconnected.')) {
    state.connectedPlayers = (state.connectedPlayers || 0) - 1
    // Players: 1
  } else if (text.includes('Players:')) {
    state.connectedPlayers = parseInt(text.split('Players: ')[1])
  }
}

async function stop() {
  if (state.status === 'init')
    return Response.json({ message: 'Server is not started' })
  if (state.status === 'stopping')
    return Response.json({ message: 'Already stopping' })
  if (state.status === 'stopped')
    return Response.json({ message: 'Already stopped' })
  if (state.status === 'starting')
    return Response.json({ message: 'Wait for starting' })

  command('stop')
  return Response.json({ message: 'Stopped' })
}

async function reset() {
  if (state.status !== 'stopped') await command('stop')

  await new Promise((resolve) => setTimeout(resolve, 1000))
  state.status = 'stopping'

  // send SIGHUP to the process
  state.process?.kill(1)

  console.log('stopeed', state.process?.exitCode, await state.process?.exited)
  state.status = 'stopped'

  setTimeout(() => {
    console.log('📦 reset')
    process.exit(0)
  }, 100)
  return Response.json({ message: 'Reset' })
}

async function prepare() {
  // openjdk 11.0.22 2024-01-16
  // OpenJDK Runtime Environment Homebrew (build 11.0.22+0)
  // OpenJDK 64-Bit Server VM Homebrew (build 11.0.22+0, mixed mode)
  const java = await $`java --version`.quiet()
  // if (!java.stdout.toString().includes('OpenJDK Runtim')) {
  //   console.log('📦 '+'OpenJDK is not installed')
  // }
  const output = java.stdout.toString() + java.stderr.toString()

  if (!output.includes('openjdk')) console.log('🔴', output)
  else console.log('👍', output.split('\n')[0])

  // download the server jar
  const tag_name = 'v146'
  const url = `https://github.com/Anuken/Mindustry/releases/download/${tag_name}/server-release.jar`
  const jar = 'server-release.jar'
  const downloaded = await $`wget -nv -c ${url} -O ${jar}`.quiet()

  if (
    !downloaded.stdout.toString().length &&
    !downloaded.stderr.toString().length
  )
    console.log('👍 Server binary', tag_name)
  else {
    // Parse [x/x] from wget
    // Downloaded  2024-02-12 18:00:55 URL:https://objects.githubusercontent.com/github-production-release-asset-2e65be/89822531/e7eabc7d-f11b-4e2f-9acd-ff154d7086aa?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAVCODYLSA53PQK4ZA%2F20240212%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20240212T165943Z&X-Amz-Expires=300&X-Amz-Signature=03e439d9c700a8a75bd1aa4cde0eda58031658cc77f06d515de0b3cb79f9fc54&X-Amz-SignedHeaders=host&actor_id=0&key_id=0&repo_id=89822531&response-content-disposition=attachment%3B%20filename%3Dserver-release.jar&response-content-type=application%2Foctet-stream [9612239/9612239] -> "server-release.jar" [1]
    const match = downloaded.stderr.toString().match(/\[(\d+)\/(\d+)\]/)
    if (match) console.log('📦 Downloaded', parseInt(match[1]) / 1000000, 'MB')
    else {
      console.log(
        '📦 Downloaded',
        downloaded.stdout.toString(),
        downloaded.stderr.toString(),
        downloaded.stdout.toString().length,
        downloaded.stderr.toString().length
      )
    }
  }
}
function removeShellColors(input: string): string {
  return input.replace(/\x1B\[\d+m/g, '') // Regular expression to match ANSI escape codes for colors
}

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason)
  // Application specific logging, throwing an error, or other logic here
})

// before exit
process.on('beforeExit', (code) => {
  console.log('📦 Process beforeExit event with code: ', code)
  state.process?.kill()
})

// Listen for termination signals allows Ctrl+C in docker run
process.on('SIGINT', () => {
  console.log('📦 Received SIGINT')
  state.process?.kill()
  setTimeout(() => {
    process.exit(0)
  }, 1000)
})
process.on('SIGTERM', () => {
  console.log('📦 Received SIGTERM')
  process.exit(0)
})

function random() {
  return Math.random().toString(36).slice(2)
}
