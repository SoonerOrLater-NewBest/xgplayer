import Mp4Remuxer from './remux/Mp4remux'
import Demuxer from './demux/Demuxer'
import FlvParser from './FlvParser'
import TagDemuxer from './demux/TagDemuxer'
import Store from '../models/Store'
import VodTask from '../tasks/VodTask'
import LiveTask from '../tasks/LiveTask'
import { EventTypes } from '../constants/types'
import Buffer from '../write/Buffer'

export default class MainParser extends Demuxer {
  constructor (config, player) {
    super()
    this.CLASS_NAME = this.constructor.name
    this._config = config
    this._player = player
    this._tempBaseTime = 0
    this.firstFlag = true
    this._store = new Store()
    this._store.isLive = config.isLive || false
    this.flvParser = new FlvParser(this._store)
    this.tagDemuxer = new TagDemuxer(this._store)
    this._mp4remuxer = new Mp4Remuxer()
    this._mp4remuxer.isLive = config.isLive || false
    this.buffer = new Buffer()
    this.bufferKeyframes = new Set()
    this.META_CHUNK_SIZE = 2 * Math.pow(10, 5)
    this.CHUNK_SIZE = Math.pow(10, 6)
    this.ftyp_moof = null
    this.isSourceOpen = false
    this._isNewSegmentsArrival = false
    this.isSeeking = false
    this.loadTask = null
    this.mse = null
    this.range = {
      start: -1,
      end: -1
    }
    this._isMediaInfoInited = false
    this._pendingFragments = []
    this._pendingRemoveRange = []
    this.err_cnt = 0
    this.requestConfig = {
      mode: this._config.cors ? 'cors' : 'same-origin'
    }
    this.initEventBind()
  }

  startLoadData () {
    if (!this._config.isLive) {
      this.initMeta()
    } else {
      this.initLiveStream()
    }
  }

  initLiveStream () {
    new LiveTask(this._config.url, this.requestConfig).run(this.loadLiveData.bind(this))
  }

  loadLiveData (buffer) {
    if (buffer === undefined) {
      this.emit('live-end')
    }
    this.buffer.write(new Uint8Array(buffer))
    let offset = this.setFlv(this.buffer.buffer)
    this.buffer.buffer = this.buffer.buffer.slice(offset)
  }

  initMeta () {
    const self = this
    const Resolver = {
      resolveChunk ({timeStamp, buffer}) {
        if (timeStamp !== self.loadTask.timeStamp) return
        self.err_cnt = 0
        self.buffer.write(new Uint8Array(buffer))
        let offset = self.setFlv(self.buffer.buffer)
        self.buffer.buffer = self.buffer.buffer.slice(offset)
        if (!self.isMediaInfoReady) {
          self.initMeta()
        }
      }
    }
    this.range = {
      start: this.range.end + 1,
      end: this.range.end + this.META_CHUNK_SIZE
    }
    const loadData = () => {
      return this.loadMetaData(this.range.start, this.range.end).then(Resolver.resolveChunk).catch((e) => {
        if (this.err_cnt >= 3) {
          this._player.emit('error', '加载视频失败')
          return
        }
        this.err_cnt += 1
        loadData()
      })
    }
    return loadData()
  }

  loadSegments (changeRange, currentTime = 0, preloadTime) {
    this._isNewSegmentsArrival = false
    const resolveChunk = ({timeStamp, buffer}) => {
      if (timeStamp !== this.loadTask.timeStamp) return
      this.err_cnt = 0
      this.buffer.write(new Uint8Array(buffer))
      let offset = this.setFlv(this.buffer.buffer)

      this.buffer.buffer = this.buffer.buffer.slice(offset)
      if (!this._isNewSegmentsArrival) {
        this.loadSegments(true)
      } else {
        this.isSeeking = false
      }
    }
    if (changeRange) {
      let _range = this.range

      if (this.getNextRangeEnd(currentTime, preloadTime) <= _range.end) {
        return Promise.resolve()
      }

      this.range = {
        start: this.range.end + 1,
        end: currentTime === undefined ? this.range.end + this.CHUNK_SIZE - 1 : this.getNextRangeEnd(currentTime, preloadTime) - 1
      }

      if (this.range.start >= this.range.end || !this.range.end) {
        this.range = _range
        return Promise.resolve()
      }
    }
    const loadData = () => {
      return this._loadSegmentsData(this.range.start, this.range.end).then(resolveChunk).catch(e => {
        if (this.err_cnt >= 3) {
          this._player.emit('error', '加载视频失败')
          return
        }
        this.err_cnt += 1
        loadData()
      })
    }
    return loadData()
  }

  getNextRangeEnd (start, preloadTime) {
    const { keyframes: { times, filePositions }, videoTimeScale } = this._store
    if (!times || !filePositions) { return this.range.end + this.CHUNK_SIZE }
    start *= videoTimeScale

    let expectEnd = start + (preloadTime * videoTimeScale)
    if (expectEnd > times[times.length - 1]) { return filePositions[filePositions.length - 1] }
    let left = 0
    let right = times.length - 1
    let index

    while (left <= right) {
      let mid = Math.floor((right + left) / 2)
      if (times[mid] <= expectEnd && expectEnd <= times[mid + 1]) {
        index = mid
        break
      } else if (left === right) {
        index = mid
        break
      } else if (expectEnd < times[mid]) {
        right = mid - 1
      } else {
        left = mid + 1
      }
    }

    return index ? filePositions[index] : undefined
  }

  _loadSegmentsData (start = 0, end = start + this.CHUNK_SIZE) {
    this.loadTask = new VodTask(this._config.url, [start, end], this.requestConfig)
    return this.loadTask.promise
  }

  loadMetaData (start = 0, end = start + this.META_CHUNK_SIZE) {
    this.loadTask = new VodTask(this._config.url, [start, end], this.requestConfig)
    return this.loadTask.promise
  }
  setFlvFirst (arrayBuff, baseTime) {
    const offset = this.flvParser.setFlv(new Uint8Array(arrayBuff))
    const { tags } = this._store.state

    if (tags.length) {
      if (tags[0].tagType !== 18) {
        throw new Error('flv file without metadata tag')
      }

      if (this._tempBaseTime !== 0 && this._tempBaseTime === tags[0].getTime()) {
        this._store.state._timestampBase = 0
      }

      this.tagDemuxer.resolveTags(tags)
    }

    this.firstFlag = false
    return offset
  }

  setFlvUsually (arrayBuff, baseTime) {
    this.isParsing = true
    const offset = this.flvParser.setFlv(new Uint8Array(arrayBuff))
    const { tags } = this._store.state
    if (tags.length) {
      this.tagDemuxer.resolveTags(tags)
    }
    return offset
  }

  handleDataReady (audioTrack, videoTrack) {
    this._mp4remuxer.remux(audioTrack, videoTrack)
  }

  handleMetaDataReady (type, meta) {
    this._mp4remuxer.onMetaDataReady(type, meta)
  }

  handleError (e) {
    this.error(e)
  }

  handleMediaInfoReady (mediaInfo) {
    if (this._isMediaInfoInited) { return }

    const FTYP_MOOF = this._mp4remuxer.onMediaInfoReady(mediaInfo)
    if (!this.ftyp_moof) {
      this.ftyp_moof = FTYP_MOOF
      this.emit('ready', FTYP_MOOF)
    }
    this._isMediaInfoInited = true
  }
  initEventBind () {
    const prefix = 'demuxer_'
    const {
      handleError,
      handleDataReady,
      handleMetaDataReady,
      handleMediaInfoReady
    } = this

    this.on('mediaFragment', (newFrag) => {
      this._isNewSegmentsArrival = true
      this._pendingFragments.push(newFrag)
      const { randomAccessPoints } = newFrag.fragment
      if (randomAccessPoints && randomAccessPoints.length) {
        randomAccessPoints.forEach(rap => {
          this.bufferKeyframes.add(rap.dts)
        })
      }
      if (!this.isSourceOpen) { return }
      if (this._pendingFragments.length) {
        const fragment = this._pendingFragments.shift()
        if (!this.mse.appendBuffer(fragment.data)) {
          this._pendingFragments.unshift(fragment)
        } else {
          this.handleSeekEnd()
          this._player.emit('cacheupdate', this._player)
        }
      }
    })
    this.on(EventTypes.ERROR, handleError.bind(this))
    this.on(`${prefix}data_ready`, handleDataReady.bind(this))
    this.on(`${prefix}meta_data_ready`, handleMetaDataReady.bind(this))
    this.on(`${prefix}media_info_ready`, handleMediaInfoReady.bind(this))
  }
  replay () {
    this.isSourceOpen = false
    this.range = {
      start: this._store.metaEndPosition,
      end: this.getNextRangeEnd(0, this._config.preloadTime) - 1
    }
    // this.firstFlag = true;
    this._mp4remuxer.seek()
    this.flvParser.seek()
    this.clearBuffer()
    this.loadSegments(false)
  }
  clearBuffer () {
    this._pendingFragments = []
    this._pendingRemoveRange = []
  }

  seek (target) {
    this.loadTask.cancel()
    const { keyframes = {}, videoTimeScale } = this._store
    let seekStart = target * videoTimeScale
    let startFilePos
    let endFilePos
    const length = Math.min(keyframes.filePositions.length, keyframes.times.length)
    let { preloadTime } = this._config

    function getEndFilePos (time, idx) {
      if (idx === keyframes.times.length) {
        endFilePos = idx
        return false
      }
      if (time <= preloadTime && preloadTime <= keyframes.times[idx + 1]) {
        endFilePos = idx
        return false
        // 需要处理EOF的情况
      }
      return true
    }
    let lo = 0
    let hi = length - 2
    while (lo <= hi) {
      let mid = Math.floor((lo + hi) / 2)
      let currentTime = keyframes.times[mid]
      let nextTime = keyframes.times[mid + 1] ? keyframes.times[mid + 1] : Number.MAX_SAFE_INTEGER
      if ((currentTime <= seekStart && seekStart <= nextTime) || lo === hi) {
        startFilePos = mid
        preloadTime = preloadTime * videoTimeScale + seekStart
        keyframes.times.every(getEndFilePos)
        break
      } else if (seekStart < currentTime) {
        hi = mid - 1
      } else {
        lo = mid + 1
      }
    }

    if (!this.isSeeking) {
      this.isSeeking = true
    } else {
      // this.tagDemuxer = new tagDemuxer(this._store);
      this._store.clearTags()
      // return;
    }
    this._pendingFragments = []
    this._mp4remuxer.seek()
    this.flvParser.seek()
    // VodTask.clear();
    this.range = {
      start: keyframes.filePositions[startFilePos],
      end: keyframes.filePositions[endFilePos] - 1 || ''
    }
    this.buffer = new Buffer()
    this.loadSegments(false)
  }
  get setFlv () {
    return this.firstFlag ? this.setFlvFirst : this.setFlvUsually
  }

  get isMediaInfoReady () {
    return this._store.mediaInfo.isComplete
  }

  get videoDuration () {
    return this._store.mediaInfo.duration
  }
  get hasPendingFragments () {
    return !!this._pendingFragments.length
  }

  get pendingFragments () {
    return this._pendingFragments
  }

  get videoTimeScale () {
    return this._store.videoTimeScale
  }
  get hasPendingRemoveRanges () {
    return this._pendingRemoveRange.length
  }

  get pendingRemoveRanges () {
    return this._pendingRemoveRange
  }

  get isSeekable () {
    return this._store.isSeekable
  }
}
