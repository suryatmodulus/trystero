import Peer from 'simple-peer-light'
import {
  encodeBytes,
  entries,
  genId,
  initGuard,
  libName,
  mkErr,
  noOp,
  selfId,
  values
} from './utils'
import joinRoom from './room'

const occupiedRooms = {}
const sockets = {}
const socketListeners = {}
const hashLimit = 20
const offerPoolSize = 10
const defaultRedundancy = 5
const trackerAction = 'announce'
const announceMs = 33333
const defaultTrackerUrls = [
  'wss://tracker.openwebtorrent.com/',
  'wss://tracker.sloppyta.co:443/announce',
  'wss://tracker.lab.vvc.niif.hu:443/announce',
  'wss://tracker.files.fm:7073/announce'
]

export default initGuard((config, ns) => {
  const trackerUrls = config.trackerUrls || defaultTrackerUrls
  const connectedPeers = {}

  if (!trackerUrls.length) {
    throw mkErr('trackerUrls is empty')
  }

  const infoHashP = crypto.subtle
    .digest('SHA-1', encodeBytes(`${libName}:${config.appId}:${ns}`))
    .then(buffer =>
      Array.from(new Uint8Array(buffer))
        .map(b => b.toString(36))
        .join('')
        .slice(0, hashLimit)
    )

  const makeOffers = () =>
    Object.fromEntries(
      new Array(offerPoolSize).fill().map(() => {
        const peer = new Peer({initiator: true, trickle: false})

        return [
          genId(hashLimit),
          {peer, offerP: new Promise(res => peer.once('signal', res))}
        ]
      })
    )

  const onSocketMessage = async (socket, e) => {
    const infoHash = await infoHashP
    let val

    try {
      val = JSON.parse(e.data)
    } catch (e) {
      console.error(`${libName}: received malformed SDP JSON`)
      return
    }

    if (val.info_hash !== infoHash) {
      return
    }

    if (val.peer_id && val.peer_id === selfId) {
      console.log('got message from self, ignoring')
      return
    }

    const failure = val['failure reason']

    if (failure) {
      console.warn(`${libName}: torrent tracker failure (${failure})`)
      return
    }

    if (val.offer && val.offer_id) {
      console.log(`offer from ${val.peer_id}`, socket.url)
      if (connectedPeers[val.peer_id]) {
        return
      }

      if (handledOffers[val.offer_id]) {
        return
      }

      handledOffers[val.offer_id] = true

      const peer = new Peer({trickle: false})
      peer.once('signal', answer => {
        socket.send(
          JSON.stringify({
            answer,
            action: trackerAction,
            info_hash: infoHash,
            peer_id: selfId,
            to_peer_id: val.peer_id,
            offer_id: val.offer_id
          })
        )
      })

      peer.on('connect', () => onConnect(peer, val.peer_id))
      peer.on('close', () => onDisconnect(val.peer_id))
      peer.signal(val.offer)
      return
    }

    if (val.answer) {
      if (connectedPeers[val.peer_id]) {
        return
      }

      if (handledOffers[val.offer_id]) {
        return
      }

      const offer = offerPool[val.offer_id]

      if (offer) {
        const {peer} = offer

        if (peer.destroyed) {
          return
        }

        handledOffers[val.offer_id] = true
        peer.on('connect', () => onConnect(peer, val.peer_id, val.offer_id))
        peer.on('close', () => onDisconnect(val.peer_id))
        peer.signal(val.answer)
      }
    }
  }

  const announce = async (socket, infoHash) =>
    socket.send(
      JSON.stringify({
        action: trackerAction,
        info_hash: infoHash,
        numwant: offerPoolSize,
        peer_id: selfId,
        offers: await Promise.all(
          entries(offerPool).map(([id, {offerP}]) =>
            offerP.then(offer => ({offer, offer_id: id}))
          )
        )
      })
    )

  const makeSocket = (url, infoHash) => {
    if (!sockets[url]) {
      socketListeners[url] = {[infoHash]: onSocketMessage}
      sockets[url] = new Promise(res => {
        const socket = new WebSocket(url)
        socket.onopen = res.bind(null, socket)
        socket.onmessage = e =>
          values(socketListeners[url]).forEach(f => f(socket, e))
      })
    } else {
      socketListeners[url][infoHash] = onSocketMessage
    }

    return sockets[url]
  }

  const announceAll = async () => {
    const infoHash = await infoHashP

    if (offerPool) {
      cleanPool()
    }

    offerPool = makeOffers()

    trackerUrls
      .slice(0, config.trackerRedundancy || defaultRedundancy)
      .forEach(async url => {
        const socket = makeSocket(url, infoHash)

        if (socket.readyState === WebSocket.OPEN) {
          announce(socket, infoHash)
        } else if (socket.readyState !== WebSocket.CONNECTING) {
          announce(await makeSocket(url, infoHash), infoHash)
        }
      })
  }

  const cleanPool = () => {
    entries(offerPool).forEach(([id, {peer}]) => {
      if (!handledOffers[id] && !connectedPeers[id]) {
        peer.destroy()
      }
    })

    handledOffers = {}
  }

  const onConnect = (peer, id, offerId) => {
    onPeerConnect(peer, id)
    connectedPeers[id] = true

    if (offerId) {
      connectedPeers[offerId] = true
    }
  }

  const onDisconnect = id => delete connectedPeers[id]

  const announceInterval = setInterval(announceAll, announceMs)
  let onPeerConnect = noOp
  let handledOffers = {}
  let offerPool

  announceAll()

  return joinRoom(
    f => (onPeerConnect = f),
    async () => {
      const infoHash = await infoHashP

      trackerUrls.forEach(url => delete socketListeners[url][infoHash])
      delete occupiedRooms[ns]
      clearInterval(announceInterval)
      cleanPool()
    }
  )
})

export {selfId} from './utils'
