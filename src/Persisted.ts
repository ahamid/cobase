import { Transform, VPromise, VArray, Variable, spawn, currentContext, NOT_MODIFIED, getNextVersion, ReplacedEvent, DeletedEvent, AddedEvent } from 'alkali'
import * as level from './storage/level'
import when from './util/when'
import WeakValueMap from './util/WeakValueMap'
import ExpirationStrategy from './ExpirationStrategy'
import * as fs from 'fs'
import * as crypto from 'crypto'
import Index from './IndexPersisted'
import { AccessError } from './util/errors'
import { toBufferKey, fromBufferKey } from 'ordered-binary'

const expirationStrategy = ExpirationStrategy.defaultInstance
const EMPTY_CACHE_ENTRY = {}
const instanceIdsMap = new WeakValueMap()
const DB_VERSION_KEY = Buffer.from([1, 1]) // SOH, code 1
const LAST_VERSION_IN_DB_KEY = Buffer.from([1, 2]) // SOH, code 2
const INITIALIZATION_SOURCE = { isInitializing: true }

global.cache = expirationStrategy // help with debugging

class InstanceIds extends Transform.as(VArray) {
	Class: any
	cachedValue: any
	cachedVersion: any
	transform() {
		return when(this.Class.resetProcess, () => this.Class.getInstanceIds())
	}
	valueOf() {
		return when(super.valueOf(true), ids => {
			expirationStrategy.useEntry(this, ids.length)
			return ids
		})
	}
	clearCache() {
		this.cachedValue = undefined
		this.cachedVersion = -1
	}
}

const MakePersisted = (Base) => secureAccess(class extends Base {
	static DB: any
	static syncVersion: number
	static Cached: any
	_cachedValue: any
	_cachedVersion: number
	_versions: any
	version: number
	static useWeakMap = true

	constructor(id) {
		super()
		if (id == null) {
			throw new TypeError('No id provided')
		}
		if (this.constructor === Persisted) {
			throw new TypeError('Can not directly instantiate abstract Persisted class')
		}
		if (this.checkSourceVersions)
			this.readyState = 'invalidated' // start in this state for items that might not be updated so freshly loaded entities don't bypass version checks
		this.id = id
	}

	get checkSourceVersions() {
		// TODO: would like remove this once we have better invalidation of persisted entities
		return false
	}

	static getDb() {
		return this.db || (this.db = Persisted.DB.open('cachedb/' + this.name))
	}

	get jsonMultiplier() {
		return 1
	}

	get approximateSize() {
		return this.asJSON ? this.asJSON.length * this.jsonMultiplier : 100
	}

	get staysUpdated() {
		return true
	}


	static get instancesById() {
		// don't derive from instances VArray for now...just manually keep in sync
		if (!this._instancesById) {
			this._instancesById = new (this.useWeakMap ? WeakValueMap : Map)()
			this._instancesById.name = this.name
		}
		return this._instancesById
	}

	static get defaultInstance() {
		return this._defaultInstance || (this._defaultInstance = new Variable())
	}

	static for(id) {
		if (id > 0 && typeof id === 'string' || id == null) {
			throw new Error('Id should be a number or non-numeric string: ' + id + 'for ' + this.name)
		}
		const instancesById = this.instancesById
		let instance = instancesById.get(id)
		if (!instance) {
			instance = new this(id)
			let transform = this.prototype.transform
			if (transform && !transform.hasVersion && this.transformVersion) {
				let transformVersion = this.transformVersion
				if (transformVersion)
					transform.valueOf = function() {
						if (currentContext) {
							currentContext.setVersion(transformVersion)
						}
						return this
					}
				transform.hasVersion = true
				this.prototype.version = Persisted.syncVersion
				console.info('Setting default version to ', this.prototype.version)
			}
			instancesById.set(id, instance)
		}
		return instance
	}

	static getByIds(ids) {
		// for optimized access to a set of ids
		if (!(ids instanceof Array))
			ids = Array.from(ids)
		let i = 0, l = ids.length
		let values = []
		let promised = []
		const getNext = () => {
			while (i < l) {
				let value = this.for(ids[i])
				if (value && value.then) {
					// a promise, put in the list of parallel promises
					let promisedI = i++
					promised.push(value.then(value => {
						values[promisedI] = value
					}))
					if (promised.length > (this.MAX_CONCURRENCY || 100)) {
						let promisedToFinish = promised
						promised = []
						return Promise.all(promisedToFinish).then(getNext)
					}
				} else {
					values[i++] = value
				}
			}
			if (promised.length > 0) {
				return Promise.all(promised)
			}
		}
		return when(getNext(), () => values)
	}

	assignPreviousValue(event) {
		let previousValues = event.previousValues
		if (!previousValues) {
			previousValues = event.previousValues = new Map()
		}
		if (this.readyState === 'up-to-date' && this._cachedValue) {
			return previousValues.set(this, this._cachedValue)
		}
		previousValues.set(this, when(this.loadLocalData(), ({ asJSON }) => {
			// store the old version, for tracking for indices
			return asJSON && JSON.parse(asJSON)
		}))
	}

	static indexFor(propertyName, indexBy) {
		let index = this['index-' + propertyName]
		if (index) {
			return index
		}
		index = this['index-' + propertyName] = class extends Index({ Source : this }) {
			static indexBy(entity) {
				return indexBy ? indexBy(entity) : entity[propertyName]
			}
		}
		Object.defineProperty(index, 'name', { value: this.name + '-index-' + propertyName })
		index.register({ version : 0 })
		return index
	}

	transform(source) {
		return source
	}

	get allowDirectJSON() {
		return true
	}


	static updatesRecorded(event) {
		return (event && event.updatesInProgress) ? Promise.all(event.updatesInProgress) : Promise.resolve()
	}

	delete() {
		return this.constructor.remove(this.id)
	}

	reset(action) {
		this.updated()
	}

	static get ready() {
		return this.hasOwnProperty('_ready') ? this._ready :
			(this._ready = new Promise((resolve, reject) => {
				this.onReady = () => {
					resolve()
				}
				this.onDbFailure = reject
				this._registerTimeout = setTimeout(() => {
					console.error('Timeout waiting for register to be called on', this.name)
				})
			}))
	}

	static register(sourceCode: { id?: string, version?: number }) {
		this.ready // make sure the getter is called first
		// make sure these are inherited
		this.pendingWrites = []
		this.currentWriteBatch = null
		this.writeCompletion = null
		clearTimeout(this._registerTimeout)
		let moduleFilename = sourceCode.id || sourceCode
		if (global[this.name]) {
			throw new Error(this.name + ' already registered')
		}
		global[this.name] = this
		if (sourceCode.version) {
			// manually provide hash
			this.dbVersion = sourceCode.version
		} else if (typeof moduleFilename == 'string') {
			// create a hash from the module source
			this.transformVersion = fs.statSync(moduleFilename).mtime.getTime()
			let hmac = crypto.createHmac('sha256', 'portal')
			hmac.update(fs.readFileSync(moduleFilename, { encoding: 'utf8' }))
			this.dbVersion = hmac.digest('hex')
		}
		for (let Source of this.Sources || []) {
			Source.notifies(this)
		}
		// get the db state and check the transform hash
		let db = this.getDb()
		this.lastVersion = +db.getSync(LAST_VERSION_IN_DB_KEY) || 0
		let stateJSON = db.getSync(DB_VERSION_KEY)
		let didReset
		//console.log('DB starting state', this.name, stateJSON)
		let state = stateJSON && JSON.parse(stateJSON)
		if (state && (state.dbVersion || state.transformHash) == this.dbVersion) {
			this.startVersion = this.version = state.startVersion
		} else {
			console.log('transform/database version mismatch, reseting db table', this.name, state && state.dbVersion, this.dbVersion)
			this.startVersion = this.version = Date.now()
			const clearDb = !!state // if there was previous state, clear out all entries
			this.didReset = when(this.resetAll(clearDb), () => when(this.writeCompletion, () => this.updateDBVersion()))
		}
		this.instancesById // trigger this initialization
		return when(this.didReset, this.onReady, this.onDbFailure)
	}

	static findUntrackedInstances() {
		for (let instance of this._instancesById.values()) {
			if (instance._cachedValue && instance._cachedValue !== EMPTY_CACHE_ENTRY) {
				if (!expirationStrategy.cache.indexOf(instance)) {
					console.log(instance.id, 'is untracked')
				}
			}
		}
	}

	updated(event = new ReplacedEvent(), by?) {
		if (!event.source) {
			event.source = this
		}
		let Class = this.constructor
		if (event.type === 'added') {
			// if we are being notified of ourself being created, ignore it
			this.constructor.instanceSetUpdated(event)
			if (this.readyState) {
				return event
			}
			if (this.cachedVersion > -1) {
				return event
			}
		}
		if (Class.updateWithPrevious) {
			this.assignPreviousValue(event)
		}
		if (event.noReset)
			Variable.prototype.updated.apply(this, arguments)
		else
			super.updated(event, by)
		if (event.type == 'deleted') {
			this.readyState = 'no-local-data'
			this.constructor.instanceSetUpdated(event)
		} else if (!event.noReset)
			this.resetCache()
		// notify class listeners too
		for (let listener of this.constructor.listeners || []) {
			listener.updated(event, this)
		}

		event.whenWritten = Class.writeCompletion // promise for when the update is recorded, this will overwrite any downstream assignment of this property
		return event
	}

	static instanceSetUpdated(event) {
		let instanceIds = instanceIdsMap.get(this.name)
		if (instanceIds) {
			instanceIds.updated(event)
		}
	}

	resetCache() {
	}

	static updated(event, by?) {
		// this should be called by outside classes
		this.updateVersion()
		if (event && !event.version) {
			event.version = this.version
		}
		let instance
		for (let Source of this.Sources || []) {
			if (by && by.constructor === Source) {
				instance = this.for(by.id)
				instance.updated(event, by)
				return event
			}
		}
		if (event && event.type == 'reset' && !this.resetProcess) {
			throw new Error('Deprecated')
		}
		for (let listener of this.listeners || []) {
			listener.updated(event, by)
		}
		return event
	}

	static updateDBVersion() {
		let version = this.startVersion
		this.getDb().put(DB_VERSION_KEY, JSON.stringify({
			startVersion: version,
			dbVersion: this.dbVersion
		})).then(() => {
			console.log('updated db version', this.name, version, this.dbVersion, this.getDb().getSync(DB_VERSION_KEY))
		})
		return version
	}

	static notifies(target) {
		// standard variable handling
		return Variable.prototype.notifies.call(this, target)
	}
	static stopNotifies(target) {
		// standard variable handling
		return Variable.prototype.stopNotifies.call(this, target)
	}
	static whenUpdatedTo(version) {
		// transitively wait on all sources that need to update to this version
		let promises = []
		for (let Source of this.Sources || []) {
			let whenUpdated = Source.whenUpdatedTo(version)
			if (whenUpdated && whenUpdated.then) {
				promises.push(whenUpdated)
			}
		}
		if (promises.length > 1) {
			return Promise.all(promises)
		} else if (promises.length == 1) {
			return promises[0]
		}
	}
	static get instanceIds() {
		let instanceIds = instanceIdsMap.get(this.name)
		if (!instanceIds) {
			instanceIdsMap.set(this.name, instanceIds = new InstanceIds())
			instanceIds.Class = this
		}
		return instanceIds
	}
})

const KeyValued = (Base, { versionProperty, valueProperty }) => class extends Base {

	loadLocalData(now, asBuffer) {
		let Class = this.constructor
		let db = Class.getDb()
		const withValue = data => {
			if (data) {
				let separatorIndex = data.indexOf(',')
				if (separatorIndex > -1) {
					return {
						version: +data.slice(0, separatorIndex),
						asJSON: data.slice(separatorIndex + 1)
					}
				} else if (isFinite(data)) {
					// stored as an invalidated version
					return {
						version: +data
					}
				}
			} else {
				return {}
			}
		}
		return when(Class.dbGet(this.id, asBuffer), withValue)
	}

	loadLatestLocalData() {
		this.readyState === 'loading-local-data'
		return when(this.loadLocalData(false, this.allowDirectJSON), (data) => {
			const { version, asJSON } = data
			if (asJSON) {
				this.readyState = 'up-to-date'
				this.version = Math.max(version, this.version || 0)
				this[versionProperty] = version
				this.asJSON = asJSON
				expirationStrategy.useEntry(this, this.jsonMultiplier * asJSON.length)
			} else if (version) {
				this.version = Math.max(version, this.version || 0)
				this.readyState = 'invalidated'
			} else {
				this.updateVersion()
				this.readyState = 'no-local-data'
			}
			return data
		})
	}

	static getInstanceIds(range) {
		let db = this.getDb()
		let options = {
			gt: Buffer.from([2]),
			values: false
		}
		if (range) {
			if (range.gt != null)
				options.gt = toBufferKey(range.gt)
			if (range.lt != null)
				options.lt = toBufferKey(range.lt)
			if (range.gte != null)
				options.gte = toBufferKey(range.gte)
			if (range.lte != null)
				options.lte = toBufferKey(range.lte)
		}
		return when(this.currentWriteBatch && this.currentWriteBatch.completion, () =>
			db.iterable(options).map(({ key }) => fromBufferKey(key)).asArray)
	}

	static entries(opts) {
		let db = this.getDb()
		return db.iterable({
			gt: Buffer.from([2])
		}).map(({ key, value }) => ({key: fromBufferKey(key), value})).asArray
	}

	/**
	* Iterate through all instances to find instances since the given version
	**/
	static getInstanceIdsAndVersionsSince(sinceVersion: number): { id: number, version: number }[] {
		return this.ready.then(() => {
			let db = this.getDb()
			this.lastVersion = this.lastVersion || +db.getSync(LAST_VERSION_IN_DB_KEY) || 0
			if (this.lastVersion <= sinceVersion) {
				return []
			}
//			console.log('Scanning for updates from', sinceVersion, this.lastVersion, this.name)
			return db.iterable({
				gt: Buffer.from([2])
			}).map(({ key, value }) => {
				const separatorIndex = value.indexOf(',')
				const version = separatorIndex > -1 ? +value.slice(0, separatorIndex) : +value
				return version > sinceVersion ? {
					id: fromBufferKey(key),
					version
				} : null
			}).filter(idAndVersion => {
				return idAndVersion
			}).asArray.then(idsAndVersions =>
				idsAndVersions.sort((a, b) => a.version > b.version ? 1 : -1)
			)
		})
	}


	static remove(id, event?) {
		if (id > 0 && typeof id === 'string' || !id) {
			throw new Error('Id should be a number or non-numeric string: ' + id)
		}
		event || (event = new DeletedEvent())
		let entity = this.for(id)
		if (this.updateWithPrevious) {
			entity.assignPreviousValue(event)
		}
		expirationStrategy.deleteEntry(entity)
		this.dbPut(id)
		this.instancesById.delete(id)
		return this.updated(event, entity)
	}

	get [valueProperty]() {
		if (this._cachedValue && this._cachedValue !== EMPTY_CACHE_ENTRY) {
			return this._cachedValue
		}
		return this._cachedValue = when(this.loaded, () => {
			if (this.asJSON) {
				let data = this.asJSON && JSON.parse(this.asJSON.toString('utf8'))
				return this._cachedValue = data
			} else {
				this._cachedValue = undefined
			}
		})
	}

	set [valueProperty](value) {
		this._cachedValue = value
		let newToCache = !this.readyState || this.readyState == 'no-local-data'
		if (newToCache) {
			this.readyState = 'loading-local-data'
		}
		let oldJSON = this.asJSON
		if (this.constructor.returnsAsyncIterables) {
			value = when(value, value => {
				let resolutions = []
				function resolveData(data) {
					if (typeof data === 'object' && !(data instanceof Array)) {
						if (data[Symbol.asyncIterator]) {
							let asArray = data.asArray
							if (asArray.then)
								resolutions.push(data.asArray)
						} else {
							for (let key of data) {
								resolveData(data[key])
							}
						}
					}
				}
				resolveData(value)
				if (resolutions.length > 0) {
					return (resolutions.length > 1 ? Promise.all(resolutions) : resolutions[0]).then(() => value)
				}
				return value
			})
		}
		let result = when(value, value => {
			if (!value) {
				if (newToCache) {
					this.readyState = 'no-local-data'
					// object not found, this basically results in a 404, no reason to store or keep anything
					return
				}
				console.warn('Setting empty value', value, 'for', this.id, this.constructor.name)
				this.readyState = 'invalidated'
			}
			let json = this.asJSON = value && JSON.stringify(this._cachedValue = value)
			let result
			if (this.constructor._instancesById.get(this.id) != this) {
				if (this.shouldPersist !== false)
					console.warn('Attempt to set value on non-canonical instance', this.id)
				return
			}
			let Class = this.constructor
			if (this.shouldPersist !== false) {
				let db = Class.getDb()
				let version = this[versionProperty]
				let data = json ? version + ',' + json : version.toString()
				when(Class.dbPut(this.id, data, version), () => {
					if (newToCache) {
						// fire an updated, if it is a new object
						let event = new AddedEvent()
						event.version = version
						Class.instanceSetUpdated(event)
						Class.updated(event, this)
					} else if (oldJSON && !oldJSON.then) {
						// if there was old JSON, send updated. Generally this won't be the case
						// as the updated() will record the old JSON and clear it, but if this was invalidated
						// due to version numbers alone, then this will record it.
						//this.constructor.updated(new ReplacedEvent(), this)
					}
				}, error => {
					this.asJSON = this._cachedValue = undefined
					console.error('Writing ' + Class.name + ':' + this.id, error)
				})
			}
			expirationStrategy.useEntry(this, this.jsonMultiplier * (json || '').length)
			return json
		})
		if (result && result.then) {
			// if we are waiting, set the asJSON as the promise
			this.asJSON = result
		}
	}

	static dbPut(key, value, version) {
		if (!this.pendingWrites) {
			this.pendingWrites = []
		}
		this.lastVersion = Math.max(this.lastVersion || 0, version || getNextVersion())
		let currentWriteBatch = this.currentWriteBatch
		let writeCompletion = this.writeCompletion
		if (!currentWriteBatch) {
			currentWriteBatch = this.currentWriteBatch = new Map()
			this.pendingWrites.push(currentWriteBatch)
			currentWriteBatch.writes = 0
			currentWriteBatch.writeSize = 0
			const lastWriteCompletion = writeCompletion
			writeCompletion = this.writeCompletion = new Promise((resolve, reject) => {
				currentWriteBatch.commitOperations = () => {
					currentWriteBatch.commitOperations = () => {} // noop until finished
					clearTimeout(delayedCommit)
					// We are waiting for the last operation to finish before we start the next one
					// not sure if that is the right way to do it, maybe we should allow overlapping commits?
					when(lastWriteCompletion, () => { // always wait for last one to complete
						let operations = []
						let lastVersion = 0
						for (let [ key, putOperation ] of currentWriteBatch) {
							lastVersion = Math.max(putOperation.version)
							operations.push(putOperation)
						}
						// store the current version number
						operations.push({
							type: 'put',
							key: LAST_VERSION_IN_DB_KEY,
							value: this.lastVersion
						})
						this.currentWriteBatch = null
						const finished = () => {
							this.pendingWrites.splice(this.pendingWrites.indexOf(currentWriteBatch), 1)
							if (this.writeCompletion == writeCompletion) {
								this.writeCompletion = null
							}
							resolve()
						}
						return this.getDb().batch(operations).then(finished, (error) => {
							console.error(error)
							finished()
						})
					})
				}
				const delayedCommit = setTimeout(currentWriteBatch.commitOperations, 20)
			})
		}
		currentWriteBatch.set(key, {
			type: value === undefined ? 'remove' : 'put',
			key: toBufferKey(key),
			value
		})
		if (currentWriteBatch.writes++ > 100 || value && (currentWriteBatch.writeSize += (value.length || 10)) > 100000) {
			currentWriteBatch.commitOperations()
		}
		return writeCompletion
	}

	static dbGet(key, asBuffer) {
		if (!this.pendingWrites) {
			this.pendingWrites = []
		}
		for (let i = this.pendingWrites.length - 1; i >= 0; --i) {
			let pendingWrite = this.pendingWrites[i]
			if (pendingWrite.has(key)) {
				return pendingWrite.get(key).value
			}
		}
		return this.getDb()[this.isAsync ? 'get': 'getSync'](toBufferKey(key), asBuffer)
	}

	valueOf() {
		let context = currentContext
		if (context && !this.allowDirectJSON && context.ifModifiedSince > -1) {
			context.ifModifiedSince = undefined
		}
		let result = when(this.readyState || this.loadLatestLocalData(), () => {
			const getValue = () => {
				if (this.cachedVersion > -1 && context && context.preferJSON && this.allowDirectJSON) {
					context.ifModifiedSince = this.cachedVersion
					return when(super.valueOf(true), value =>
						value === NOT_MODIFIED ?
							{ asJSON: this.asJSON } : value)
				}
				return super.valueOf(true)
			}
			if (context && currentContext !== context)
				return context.executeWithin(getValue)
			else
				return getValue()
		})
		return result
	}

	clearCache() {
		this.asJSON = null
		this._cachedValue = undefined
		this.cachedVersion = -1
		if (this.readyState === 'up-to-date' || this.readyState === 'invalidated') {
			this.readyState = undefined
		}
	}
}


export class Persisted extends KeyValued(MakePersisted(Variable), {
	valueProperty: 'value',
	versionProperty: 'version'
}) {
	db: any
	static getDb() {
		return this.db || (this.db = Persisted.DB.open('portaldb/' + this.name))
	}

	static resetAll(clearDb): any {
	}

	patch(properties) {
		return this.then((value) =>
			when(this.put(value = Object.assign(value || {}, properties)), () => value))
	}
	static DB = level
	static syncVersion = 10
}

Persisted.getSyncStartDb = function() {
	return this.syncStartDb || (this.syncStartDb = Persisted.DB.open('cachedb/sync-start'))
}
Persisted.getSyncVersion = function() {
	return this.getSyncStartDb().get('version').then(version =>
		(version && version <= Date.now()) ?
			this.syncVersion = +version :
			Persisted.newSyncVersion()
	)
}
Persisted.newSyncVersion = function() {
	const newVersion = this.syncVersion = Date.now() // using timestamp versioning
	this.getSyncStartDb().putSync('version', newVersion)
	return newVersion
}

export default Persisted
export const Persistable = MakePersisted(Transform)

export class Cached extends KeyValued(MakePersisted(Transform), {
	valueProperty: 'cachedValue',
	versionProperty: 'cachedVersion'
}) {
	allowDirectJSON: boolean
	static Sources: any[]
	static fetchAllIds: () => {}[]
	is(value) {
		// we skip loadLocalData and pretend it wasn't in the cache... not clear if
		// that is how we want is() to behave or not
		let event = new ReplacedEvent()
		event.noReset = true // should just be an optimization to avoid unnecessary db puts
		this.updated(event)
		this.cachedVersion = this.version
		this.cachedValue = value
		this.readyState = 'up-to-date'
		return this
	}

	static resetAll(clearDb) {
		console.log('reset all for ', this.name)
		return Promise.resolve(spawn(function*() {
			let version = this.startVersion = Date.now()
			let allIds = yield this.fetchAllIds ? this.fetchAllIds() : []
			if (clearDb) {
				console.info('Closing the database to clear', this.name)
				let db = this.getDb()
				yield db.clear()
				console.info('Cleared the database', this.name, 'rebuilding')
			}// else TODO: if not clearDb, verify that there are no entries; if there are, remove them
			for (let id of allIds) {
				if (this.instancesById.get(id)) {
					// instance already in memory
					this.for(id).updated()
					continue
				}
				const version = getNextVersion() // we give each entry its own version so that downstream indices have unique versions to go off of
				this.dbPut(id, version.toString(), version)
			}
			yield (this.writeCompletion)
			console.info('Done reseting', this.name)
		}.bind(this)))
	}

	resetCache(event) {
		this._cachedValue = undefined
		this.updateVersion()
		let version = this.version
		if (this.shouldPersist !== false) {
//			if (!this.loaded || this.asJSON || oldJSON) { // maybe this might be a little faster if it is already invalidated
			// storing as a version alone to indicate invalidation
			this.constructor.dbPut(this.id, version.toString(), version)
//			}
		}
		this.asJSON = undefined
	}

	static get version() {
		if (this.Sources) {
			return Math.max(this._version || 1, ...(this.Sources.map(Source => Source.version)))
		} else {
			return this._version || 1
		}
	}
	static set version(version) {
		this._version = version
	}

	static from(...Sources: Array<Function | {notifies: () => any, for: (id: any) => any}>) {
		if (!Sources[0]) {
			throw new Error('No source provided')
		}
		class CachedFrom extends this {
			constructor(id) {
				super(id)
				for (let i = 0; i < Sources.length; i++) {
					this['source' + (i ? i : '')] = Sources[i].for(id)
				}
			}
			get checkSourceVersions() {
				return false
			}
		}
		for (let Source of Sources) {
			if (Source.returnsAsyncIterables) {
				this.returnsAsyncIterables
			}
		}
		CachedFrom.Sources = Sources
		return CachedFrom
	}

	static getInstanceIds(range) {
		if (!this.fetchAllIds && this.Sources && this.Sources[0] && this.Sources[0].getInstanceIds) {
			// if we don't know if we have all our ids, our source is a more reliable source of instance ids
			return this.Sources[0].getInstanceIds(range)
		}
		return super.getInstanceIds(range)
	}

	static register(sourceCode) {
		const registered = super.register(sourceCode)
		when(registered, () => {
			let receivedPendingVersion = []
			for (let Source of this.Sources || []) {
				receivedPendingVersion.push(Source.getInstanceIdsAndVersionsSince && Source.getInstanceIdsAndVersionsSince(this.lastVersion).then(ids => {
//					console.log('getInstanceIdsAndVersionsSince for', this.name, ids.length)
					let min = Infinity
					let max = 0
					for (let { id, version } of ids) {
						min = Math.min(version, min)
						max = Math.max(version, max)
						let event = new ReplacedEvent()
						event.source = INITIALIZATION_SOURCE
						this.for(id).updated(event)
					}
//					console.log('getInstanceIdsAndVersionsSince min/max for', this.name, min, max)
				}))
			}
		})
		return registered
	}

	get whenProcessingComplete() {
		return this.Sources && Promise.all(this.Sources.map(Source => Source.whenProcessingComplete))
	}
}
type permission = (source: any, session: object) => boolean

type PermissionCheck = (source: any, session: any, action: string, args: Array<any>) => boolean | string

type Secured = {
	allow(...permissions: Array<PermissionCheck>): any
}

export function secureAccess<T>(Class: T): T & Secured {
	Class.allow = function(...permissions: Array<PermissionCheck>) {
		let Class = this
		let methodOverrides = {
			for(id) {
				let target = Class.for(id)
				return new Proxy(target, handler)
			},
			stopNotifies(target) {
				// skip permissions on this
				return this.stopNotifies(target)
			},
			isChecked() {
				return true
			}
		}
		let handler = {
			get(target, name) {
				let value = target[name]
				if (methodOverrides[name]) {
					return methodOverrides[name].bind(target)
				}
				if (typeof value === 'function') {
					return function() {
						let context = currentContext
						// create a new derivative context that includes the session, but won't
						// update the version/timestamp
						return context.newContext().executeWithin(() => {
							let awaitingListener, variable
							let result = when(secureAccess.checkPermissions(permissions, target, name, [...arguments]), (permitted) => {
								if (permitted !== true) {
									throw new AccessError('User does not have required permissions: ' + permitted + ' for ' + Class.name)
								}
								return context.executeWithin(() => {
									variable = value.apply(target, arguments)
									if (awaitingListener) {
										variable.notifies(awaitingListener)
									}
									return variable
								})
							})
							// promises get resolved all the way through, so need to proxy notifies calls
							if (result && result.then && !result.notifies) {
								result.notifies = listener => awaitingListener = listener
								result.stopNotifies = listener => variable.stopNotifies(listener)
							}
							return result
						})
					}
				} else {
					return value
				}
			}
		}
		return new Proxy(this, handler)
	}
	return Class
}
secureAccess.checkPermissions = () => true
