import {
  keys,
  values,
  entries,
  events,
  mkErr,
  noOp,
  encodeBytes,
  decodeBytes
} from './utils'

const TypedArray = Object.getPrototypeOf(Uint8Array)
const typeByteLimit = 12
const metaTagSize = typeByteLimit + 2
const chunkSize = 16 * 2 ** 10 - metaTagSize
const buffLowEvent = 'bufferedamountlow'

export default (onPeer, onSelfLeave) => {
  const peerMap = {}
  const actions = {}
  const pendingTransmissions = {}
  const exitPeer = id => {
    if (!peerMap[id]) {
      return
    }
    delete peerMap[id]
    delete pendingTransmissions[id]
    onPeerLeave(id)
  }

  let onPeerJoin = noOp
  let onPeerLeave = noOp
  let onPeerStream = noOp
  let selfStream

  onPeer((peer, id) => {
    if (peerMap[id]) {
      return
    }

    peerMap[id] = peer

    if (selfStream) {
      peer.addStream(selfStream)
    }

    peer.on(events.close, () => exitPeer(id))
    peer.on(events.stream, stream => onPeerStream(stream, id))
    peer.on(events.data, data => {
      const buffer = new Uint8Array(data)
      const action = decodeBytes(buffer.subarray(0, typeByteLimit))
      const nonce = buffer.subarray(typeByteLimit, typeByteLimit + 1)[0]
      const tag = buffer.subarray(typeByteLimit + 1, typeByteLimit + 2)[0]
      const payload = buffer.subarray(typeByteLimit + 2)
      const isLast = !!(tag & 1)
      const isMeta = !!(tag & (1 << 1))
      const isBinary = !!(tag & (1 << 2))
      const isJson = !!(tag & (1 << 3))

      if (!actions[action]) {
        throw mkErr(`received message with unregistered type (${action})`)
      }

      if (!pendingTransmissions[id]) {
        pendingTransmissions[id] = {}
      }

      if (!pendingTransmissions[id][action]) {
        pendingTransmissions[id][action] = {}
      }

      let target = pendingTransmissions[id][action][nonce]

      if (!target) {
        target = pendingTransmissions[id][action][nonce] = {chunks: []}
      }

      if (isMeta) {
        target.meta = JSON.parse(decodeBytes(payload))
      } else {
        target.chunks.push(payload)
      }

      if (!isLast) {
        return
      }

      const {chunks} = target
      const full = new Uint8Array(chunks.reduce((a, c) => a + c.byteLength, 0))

      chunks.forEach((b, i) => full.set(b, i && chunks[i - 1].byteLength))

      if (isBinary) {
        actions[action](full, id, target.meta)
      } else {
        const text = decodeBytes(full)
        actions[action](isJson ? JSON.parse(text) : text, id)
      }

      delete pendingTransmissions[id][action][nonce]
    })
    peer.on(events.error, e => {
      if (e.code === 'ERR_DATA_CHANNEL') {
        return
      }
      console.error(e)
    })

    setTimeout(onPeerJoin, 0, id)
  })

  return {
    makeAction: type => {
      if (!type) {
        throw mkErr('action type argument is required')
      }

      if (actions[type]) {
        throw mkErr(`action '${type}' already registered`)
      }

      const typeEncoded = encodeBytes(type)

      if (typeEncoded.byteLength > typeByteLimit) {
        throw mkErr(
          `action type string "${type}" (${typeEncoded.byteLength}b) exceeds ` +
            `byte limit (${typeByteLimit}). Hint: choose a shorter name.`
        )
      }

      const typeBytes = new Uint8Array(typeByteLimit)
      typeBytes.set(typeEncoded)

      const typePadded = decodeBytes(typeBytes)

      let nonce = 0

      actions[typePadded] = noOp
      pendingTransmissions[type] = {}

      return [
        async (data, peerId, meta) => {
          const peers = entries(peerMap)

          if (!peers.length) {
            return
          }

          if (meta && typeof meta !== 'object') {
            throw mkErr('action meta argument must be an object')
          }

          const isJson = typeof data === 'object' || typeof data === 'number'
          const isBlob = data instanceof Blob
          const isBinary =
            isBlob || data instanceof ArrayBuffer || data instanceof TypedArray

          if (meta && !isBinary) {
            throw mkErr(
              'action meta argument can only be used with binary data'
            )
          }

          const buffer = isBinary
            ? new Uint8Array(isBlob ? await data.arrayBuffer() : data)
            : encodeBytes(isJson ? JSON.stringify(data) : data)

          const metaEncoded = meta ? encodeBytes(JSON.stringify(meta)) : null

          const chunkTotal =
            Math.ceil(buffer.byteLength / chunkSize) + (meta ? 1 : 0)

          const chunks = new Array(chunkTotal).fill().map((_, i) => {
            const isLast = i === chunkTotal - 1
            const isMeta = meta && i === 0
            const chunk = new Uint8Array(
              metaTagSize +
                (isMeta
                  ? metaEncoded.byteLength
                  : isLast
                  ? buffer.byteLength -
                    chunkSize * (chunkTotal - (meta ? 2 : 1))
                  : chunkSize)
            )

            chunk.set(typeBytes)
            chunk.set([nonce], typeBytes.byteLength)
            chunk.set(
              [isLast | (isMeta << 1) | (isBinary << 2) | (isJson << 3)],
              typeBytes.byteLength + 1
            )
            chunk.set(
              meta
                ? isMeta
                  ? metaEncoded
                  : buffer.subarray((i - 1) * chunkSize, i * chunkSize)
                : buffer.subarray(i * chunkSize, (i + 1) * chunkSize),
              metaTagSize
            )

            return chunk
          })

          nonce = (nonce + 1) & 0xff

          const transmit = async ([id, peer]) => {
            const chan = peer._channel
            let chunkN = 0

            while (chunkN < chunkTotal) {
              if (chan.bufferedAmount > chan.bufferedAmountLowThreshold) {
                await new Promise(res => {
                  const next = () => {
                    chan.removeEventListener(buffLowEvent, next)
                    res()
                  }
                  chan.addEventListener(buffLowEvent, next)
                })
              }

              if (!peerMap[id]) {
                break
              }

              peer.send(chunks[chunkN++])
            }
          }

          if (peerId) {
            const peer = peerMap[peerId]
            if (!peer) {
              throw mkErr(`no peer with id ${peerId} found`)
            }
            return transmit([peerId, peer])
          }

          return Promise.all(peers.map(transmit))
        },
        f => (actions[typePadded] = f)
      ]
    },

    leave: () => {
      entries(peerMap).forEach(([id, peer]) => {
        peer.destroy()
        delete peerMap[id]
      })
      onSelfLeave()
    },

    getPeers: () => keys(peerMap),

    addStream: (stream, peerId) => {
      if (typeof peerId === 'string') {
        const peer = peerMap[peerId]

        if (!peer) {
          throw mkErr(`no peer with id ${peerId} found`)
        }

        peer.addStream(stream)
      } else {
        if (!peerId) {
          selfStream = stream
        }

        values(peerMap).forEach(peer => peer.addStream(stream))
      }
    },

    removeStream: (stream, peerId) => {
      if (peerId) {
        const peer = peerMap[peerId]

        if (!peer) {
          throw mkErr(`no peer with id ${peerId} found`)
        }

        peer.removeStream(stream)
      } else {
        values(peerMap).forEach(peer => peer.removeStream(stream))
      }
    },

    onPeerJoin: f => (onPeerJoin = f),

    onPeerLeave: f => (onPeerLeave = f),

    onPeerStream: f => (onPeerStream = f)
  }
}
