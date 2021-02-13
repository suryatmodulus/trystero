import firebase from '@firebase/app'
import '@firebase/database'
import Peer from 'simple-peer-light'
import {libName, mkErr, noOp, selfId} from './utils'
import joinRoom from './room'

const presencePath = '_'
const defaultRootPath = `__${libName.toLowerCase()}__`
const occupiedRooms = {}
const getPath = (...xs) => xs.join('/')

let didInit = false
let db

const init = config => {
  if (!firebase.apps.length) {
    if (!config) {
      throw mkErr('init() requires a config map as the first argument')
    }

    if (!config.appId) {
      throw mkErr('config map is missing appId field')
    }

    firebase.initializeApp({
      databaseURL: `https://${config.appId}.firebaseio.com`
    })
  }

  didInit = true
  db = firebase.database()
}

export default (config, ns) => {
  if (!didInit) {
    init(config)
  }

  if (!ns) {
    throw mkErr('namespace argument required')
  }

  if (occupiedRooms[ns]) {
    throw mkErr(`already joined room ${ns}`)
  }

  const peerMap = {}
  const peerSigs = {}
  const rootPath = (config && config.rootPath) || defaultRootPath
  const roomRef = db.ref(getPath(rootPath, ns))
  const selfRef = roomRef.child(selfId)

  const makePeer = (id, initiator) => {
    if (peerMap[id]) {
      return peerMap[id]
    }
    const peer = new Peer({initiator})

    peer.on('connect', () => onPeerConnect(peer, id))
    peer.on('signal', sdp => {
      const ref = db.ref(getPath(rootPath, ns, id, selfId)).push()
      ref.onDisconnect().remove()
      ref.set(JSON.stringify(sdp))
    })

    peerMap[id] = peer
    return peer
  }

  let didSyncRoom = false
  let onPeerConnect = noOp

  selfRef.set({[presencePath]: true})
  selfRef.onDisconnect().remove()
  selfRef.on('child_added', data => {
    const peerId = data.key
    if (peerId !== presencePath) {
      data.ref.on('child_added', data => {
        if (!(peerId in peerSigs)) {
          peerSigs[peerId] = {}
        }

        if (data.key in peerSigs[peerId]) {
          return
        }

        peerSigs[peerId][data.key] = true

        let val

        try {
          val = JSON.parse(data.val())
        } catch (e) {
          console.error(`${libName}: received malformed SDP JSON`)
          return
        }

        const peer = makePeer(peerId, false)

        peer.signal(val)
        data.ref.remove()
      })
    }
  })

  roomRef.once('value', () => (didSyncRoom = true))
  roomRef.on('child_added', ({key}) => {
    if (!didSyncRoom || key === selfId) {
      return
    }
    makePeer(key, true)
  })

  return joinRoom(
    f => (onPeerConnect = f),
    () => {
      selfRef.off()
      selfRef.remove()
      roomRef.off()
      delete occupiedRooms[ns]
    }
  )
}

export {selfId} from './utils'
