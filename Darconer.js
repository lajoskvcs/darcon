let NATS = require('nats')
const jc = NATS.JSONCodec()

const _ = require( 'isa.js' )

const Clerobee = require( 'clerobee' )

const Assigner = require( 'assign.js' )
let assigner = new Assigner()

const fs = require('fs')
const path = require('path')
let VERSION = exports.VERSION = JSON.parse( fs.readFileSync( path.join( __dirname, 'package.json'), 'utf8' ) ).version

const { ensureDarconLog } = require('./util/Logger')

let { MODE_REQUEST, MODE_INFORM, MODE_DELEGATE, newPacket, newPresencer, newConfig } = require( './Models' )

let { BaseErrors, ErrorCreator } = require( './util/Errors' )

const HIDDEN_SERVICES_PREFIX = '_'
const ENTITY_UPDATED = 'entityUpdated'
const SERVICES_REPORTS = 'darcon_service_reports'
const PROCLAIMS = 'darcon_proclaims'
const UNDEFINED = 'ToBeFilled'
const SEPARATOR = '_'
const GATER = 'Gater'

const OK = 'OK'

const H_CHUNK_NO = 'chunkNO'
const H_CHUNK_COUNT = 'chunkCount'
const H_UID = 'uid'

let { defined } = require( './util/Helper' )

let PinoLogger = require('./PinoLogger')

function chunk(arr, chunkSize) {
	var R = []
	for (let i=0,len=arr.length; i < len; i+=chunkSize)
		R.push(arr.slice(i,i+chunkSize))
	return R;
}

function Darcon () {}

Object.assign( Darcon.prototype, {
	HIDDEN_SERVICES_PREFIX,
	ENTITY_UPDATED,
	SEPARATOR,
	name: UNDEFINED,
	nodeID: UNDEFINED,

	_randomNodeID ( entity, message ) {
		if ( this.ins && this.ins[ entity ] ) return this.nodeID

		if ( !this.presences ) {
			throw BaseErrors.EntityNotInitiated( { entity: this.name } )
		}
		if ( !this.presences[ entity ] ) {
			throw BaseErrors.NoSuchEntity( { entity, message } )
		}

		let ids = Object.keys( this.presences[ entity ] )
		if ( ids.length === 0 ) throw BaseErrors.NoSuchEntity( { entity, message } )

		let id = ids[ Math.floor( Math.random( ) * ids.length ) ]
		return id
	},
	async init (config = {}) { let self = this
		this.name = config.name || 'Daconer'
		config.logger = config.logger || PinoLogger( this.name, { level: this.logLevel, prettyPrint: process.env.DARCON_LOG_PRETTY || false } )

		config.logger = ensureDarconLog(config.logger)

		config = await newConfig( config )
		assigner.assign( self, config )

		this.clerobee = new Clerobee( this.idLength )
		this.nodeID = this.clerobee.generate( ),

		this.presences = {}
		this.messages = {}
		this.ins = {}
		this.ins[ SERVICES_REPORTS ] = {
			name: SERVICES_REPORTS,
			entity: { name: SERVICES_REPORTS }
		}
		this.ins[ PROCLAIMS ] = {
			name: PROCLAIMS,
			entity: { name: PROCLAIMS }
		}
		this.chunks = {}

		await self.connect()

		this.reporter = setInterval( () => { self.reportStatus() }, this.reporterInterval )
		this.keeper = setInterval( () => { self.checkPresence() }, this.keeperInterval )

		await this._innerCreateIn( PROCLAIMS, '', async function ( message ) {
			try {
				let proclaim = self.strict ? await newProclaimer( message ) : message
				let pMsg = proclaim.message
				if ( self[ pMsg ] )
					self[ pMsg ]( self, proclaim.entity, proclaim.terms || {} ).catch( (err) => { self.logger.darconlog(err) } )
				else
					for ( let name in self.ins ) {
						if ( self.ins[name].entity[ pMsg ] )
							self.ins[name].entity[ pMsg ]( proclaim.entity, proclaim.terms || {} ).catch( (err) => { self.logger.darconlog(err) } )
					}
				self.logger.darconlog( null, `Entity ${proclaim.entity} at ${this.name} proclaimed: ${pMsg}`, {}, 'debug' )
			} catch (err) { self.logger.darconlog( err ) }
		} )

		await this._innerCreateIn( SERVICES_REPORTS, '', async function ( message ) {
			try {
				let present = self.strict ? await newPresencer( message ) : message

				if ( !self.presences[ present.entity ] )
					self.presences[ present.entity ] = {}

				if ( self.presences[ present.entity ][ present.nodeID ] ) {
					self.presences[ present.entity ][ present.nodeID ].timestamp = Date.now()
				}
				else {
					self.presences[ present.entity ][ present.nodeID ] = {
						timestamp: Date.now(), projectVersion: present.projectVersion, entityVersion: present.entityVersion
					}

					if ( self.entityAppeared )
						self.entityAppeared( self, present.entity, present.nodeID ).catch( (err) => { self.logger.darconlog(err) } )

					self.logger.darconlog( null, `Entity ${present.entity} at ${self.name} appeared...`, {}, 'debug' )
				}
			} catch (err) { self.logger.darconlog( err ) }
		} )

		await this.publish( {
			name: GATER,
			version: VERSION
		} )

		this.Validator = config.Validator
		if ( this.Validator ) {
			if ( _.isString( this.Validator ) ) this.Validator = require( this.Validator )
			self.logger.darconlog( null, 'Validator added...', { name: this.Validator.name, version: this.Validator.version }, 'info' )
		}

		if (config.mortar.enabled) {
			try {
				let Mortar = require( './util/Mortar' )
				self.Mortar = Mortar.newMortar()
				self.logger.darconlog( null, 'Mortar starting...', {}, 'info' )
				await self.publish( self.Mortar, config.mortar )
			} catch (err) { self.logger.darconlog( err ) }
		}
	},

	async _innerCreateIn ( entityName, node, handler ) {
		let self = this

		let socketName = entityName + (node ? SEPARATOR + node : node)
		self.natsServer.subscribe( socketName, { callback: (err, message) => {
			let headers = message.headers ? {
				[H_UID]: message.headers.get( H_UID ),
				[H_CHUNK_NO]: message.headers.get( H_CHUNK_NO ),
				[H_CHUNK_COUNT]: message.headers.get( H_CHUNK_COUNT )
			} : { }
			if (!headers[ H_UID ]) return

			let dataArray = message.data

			if ( headers[ H_CHUNK_COUNT ] ) {
				if ( !self.chunks[ headers[ H_UID ] ] ) self.chunks[ headers[ H_UID ] ] = Array( headers[ H_CHUNK_COUNT ] )

				self.chunks[ headers[ H_UID ] ][ headers[ H_CHUNK_NO ] ] = message.data

				if( self.chunks[ headers[ H_UID ] ].findIndex( (element) => !element ) === -1 ) {
					dataArray = new Uint8Array([]), arraySize = 0
					for( let array of self.chunks[ headers[ H_UID ] ] ) {
						dataArray.set(stream, arraySize )
						arraySize += array.length
					}
					delete self.chunks[ incoming.uid ]
				}
				else return OK
			}

			handler( jc.decode( dataArray ) ).catch( (err) => {
				self.logger.darconlog(err)
			} )

			return OK
		} } )

		self.logger.darconlog( null, `NATS SUBSCRIBE is made to ${socketName} on ${node}`, null, 'info' )
	},

	async processMessage (incoming) {
		let self = this

		let error = incoming.comm.error ? ErrorCreator( {
			errorCode: incoming.comm.error.errorcode,
			errorName: incoming.comm.error.errorName,
			message: incoming.comm.error.message,
			event: incoming.comm.entity + '.' + incoming.comm.message
		} )() : null

		let terms = assigner.assign( {}, incoming.comm.terms || {}, {
			flowID: incoming.comm.flowID,
			processID: incoming.comm.processID,
			async request (to, message, params) {
				return self.innercomm(MODE_REQUEST, incoming.comm.flowID, incoming.comm.processID, incoming.comm.entity, self.nodeID, to, message, null, null, null, params, terms )
			},
			async inform (to, message, params) {
				return self.innercomm(MODE_INFORM, incoming.comm.flowID, incoming.comm.processID, incoming.comm.entity, self.nodeID, to, message, null, null, null, params, terms )
			},
			async delegate (to, message, delegateEntity, delegateMessage, delegateErrorMessage, params) {
				return self.innercomm(MODE_DELEGATE, incoming.comm.flowID, incoming.comm.processID, incoming.comm.entity, self.nodeID, to, message, delegateEntity, delegateMessage, delegateErrorMessage, params, terms )
			},
			comm: incoming.comm
		} )


		if ( defined(incoming.comm.response) || incoming.comm.error ) {
			incoming.comm.receptionDate = Date.now()

			if ( incoming.comm.delegateEntity && incoming.comm.delegateMessage ) {
				try {
					if ( error ) {
						self.logger.debug( error )
						await self.ins[ incoming.comm.delegateEntity ].entity[ incoming.comm.delegateErrorMessage ]( error, terms )
					}
					else await self.ins[ incoming.comm.delegateEntity ].entity[ incoming.comm.delegateMessage ]( incoming.comm.response, terms )
				} catch (err) {
					self.logger.darconlog( err )
				}
				return OK
			}

			if ( !self.messages[ incoming.uid ] ) {
				if ( incoming.comm.error ) console.error( error )
				return OK
			}
			self.messages[ incoming.uid ].callback(
				error, incoming.comm.error ? null : incoming.comm.response
			)
		}
		else {
			incoming.comm.arrivalDate = Date.now()

			incoming.comm.responderNodeID = self.nodeID

			try {
				if (!self.ins[ incoming.comm.entity ]) throw BaseErrors.NoSuchEntity( { entity: incoming.comm.entity, message: incoming.comm.message } )
				if (!self.ins[ incoming.comm.entity ].entity[ incoming.comm.message ]) throw BaseErrors.NoSuchService( { service: incoming.comm.message, entity: incoming.comm.entity } )

				if (this.Validator)
					await this.Validator.validateMessage( message )

				let paramsToPass = assigner.cloneObject( incoming.comm.params ).concat( [ terms ] )
				let response = await self.ins[ incoming.comm.entity ].entity[ incoming.comm.message ]( ...paramsToPass )
				if (!defined(response)) throw BaseErrors.NoReturnValue( { fn: incoming.comm.message, entity: incoming.comm.entity } )
				incoming.comm.response = response
			} catch (err) {
				self.logger.darconlog( err )
				incoming.comm.error = { message: err.message || err.toString(), code: err.code || err.errorCode || err.errorcode || '-1', errorName: err.errorName || '' }
			}

			if (incoming.comm.mode === MODE_INFORM) return OK

			incoming.comm.responseDate = Date.now()
			if (incoming.comm.mode === MODE_DELEGATE) {
				let socketName = incoming.comm.delegateEntity + SEPARATOR + self._randomNodeID( incoming.comm.delegateEntity, incoming.comm.message )
				self.sendOut( socketName, incoming ).catch( (err) => { self.logger.darconlog( err ) } )
			}
			else {
				let socketName = incoming.comm.source + SEPARATOR + incoming.comm.sourceNodeID
				self.sendOut( socketName, incoming ).catch( (err) => { self.logger.darconlog( err ) } )
			}

			return OK
		}
	},

	entity (name) {
		return self.ins[ name ]
	},

	async unpublish (name) {
		if ( this.ins[ name ] ) {
			let socketName = name + SEPARATOR + this.nodeID
			await this.natsServer.unsubscribe( socketName )
			delete this.ins[ name ]
		}
	},
	async publish (entity, config = {}) {
		let self = this

		let functions = _.functionNames( entity, true ).filter( (fnName) => { return !fnName.startsWith( HIDDEN_SERVICES_PREFIX ) } )

		entity.Darcon = this

		entity.request = async function (to, message, params, terms = {}) {
			return self.innercomm(MODE_REQUEST, (terms && terms.comm && terms.comm.flowID) || self.clerobee.generate( ), self.clerobee.generate( ), entity.name, self.nodeID, to, message, null, null, null, params, terms)
		}
		entity.inform = async function (to, message, params, terms = {}) {
			return self.innercomm(MODE_INFORM, (terms && terms.comm && terms.comm.flowID) || self.clerobee.generate( ), self.clerobee.generate( ), entity.name, self.nodeID, to, message, null, null, null, params, terms)
		}
		entity.delegate = async function (to, message, delegateEntity, delegateMessage, delegateErrorMessage, params, terms = {}) {
			return self.innercomm(MODE_DELEGATE, (terms && terms.comm && terms.comm.flowID) || self.clerobee.generate( ), self.clerobee.generate( ), entity.name, self.nodeID, to, message, delegateEntity, delegateMessage, delegateErrorMessage, params, terms)
		}
		entity.whisper = async function (message, params, terms = {}) {
			return self.whisper((terms && terms.comm && terms.comm.flowID) || self.clerobee.generate( ), self.clerobee.generate( ), entity.name, self.nodeID, entity.name, message, null, null, null, params, terms)
		}

		let cfg = assigner.assign( { logger: self.logger }, config, this.entities[ entity.name ] || {}, config.millieu || {} )
		if (entity.init)
			await entity.init( cfg )

		await self._innerCreateIn( entity.name, self.nodeID, async function ( message ) {
			try {
				let incoming = self.strict ? await newPacket( message ) : message

				self.logger[ self.logLevel ]( { darcon: self.name, nodeID: self.nodeID, uid: incoming.uid, flowID: incoming.comm.flowID, processID: incoming.comm.processID, received: incoming } )
				self.processMessage( incoming ).catch( (err) => { self.logger.darconlog( err ) } )
			} catch (err) {
				self.logger.darconlog( err )
			}
		} )


		if ( !self.ins[ entity.name ] )
			self.ins[ entity.name ] = {
				name: entity.name,
				version: entity.version || entity.VERSION || '1.0.0',
				services: functions,
				entity
			}

		return entity
	},

	async proclaim ( name, message, terms = {} ) { let self = this
		if ( this.ins[ name ] ){
			let entity = this.ins[ name ].entity
			if ( message === ENTITY_UPDATED ) {
				let functions = _.functionNames( entity, true ).filter( (fnName) => { return !fnName.startsWith( HIDDEN_SERVICES_PREFIX ) } )
				this.ins[ name ].services = functions
			}
		} else if ( self.strict )
			throw BaseErrors.NoSuchEntity( { entity: name, message } )

		let proclaim = { entity: name, nodeID: self.nodeID, message, terms }
		try {
			await self.natsServer.publish( PROCLAIMS, jc.encode( self.strict ? await newProclaimer( proclaim ) : proclaim ) )
		} catch ( err ) {
			self.logger.darconlog( err )
		}

		return OK
	},

	async connect () {
		let self = this

		self.logger.darconlog( null, 'Connecting to NATS:', self.nats, 'info' )

		try {
			self.natsServer = await NATS.connect( self.nats )

			self.logger.darconlog( null, 'NATS connection is made', { }, 'warn' )
		} catch (err) { reject(err) }
	},

	async close () {
		var self = this
		self.finalised = true

		if (self.reporter)
			clearInterval( self.reporter )
		if (self.keeper)
			clearInterval( self.keeper )
		if (self.cleaner)
			clearInterval( self.cleaner )

		for (let entityRef in self.ins) {
			let entity = self.ins[entityRef].entity
			if (entity.close)
				entity.close().catch( (err) => { self.logger.darconlog(err) } )
		}

		if ( self.natsServer ) {
			await self.natsServer.flush()
  			await self.natsServer.close()
		}
	},

	async cleanupMessages () {
		let self = this

		let time = Date.now()
		for ( let key of Object.keys( self.messages ) ) {
			if ( time - self.messages[key].timestamp > self.reponseTolerance ) {
				let callbackFn = self.messages[key].callback
				let entity = self.messages[key].entity
				let message = self.messages[key].message
				delete self.messages[ key ]
				delete self.chunks[ key ]
				callbackFn( BaseErrors.RequestTimeout( { entity, message, tolerance: self.reponseTolerance } ) )
			}
		}
	},

	async reportStatus () {
		let self = this

		try {
			for (let name in this.ins) {
				if (name === PROCLAIMS || name === SERVICES_REPORTS || name === GATER) continue

				let entity = this.ins[ name ]
				let report = {
					uid: self.clerobee.generate(),
					entity: entity.name,
					nodeID: self.nodeID,
					entityVersion: entity.version,
					projectVersion: VERSION
				}
				let h = NATS.headers()
				h.append(H_UID, report.uid)
				await self.natsServer.publish( SERVICES_REPORTS, jc.encode( self.strict ? await newPresencer( report ) : report ), { headers: h } )
			}
		} catch ( err ) {
			self.logger.darconlog( err )
			console.error(err)
		}
	},

	async resetup ( ) {
		let self = this

		for ( let ref of Object.keys(self.ins) )
			await this.publish( self.ins[ref].entity )

		return OK
	},

	async checkPresence () {
		let self = this

		let timestamp = Date.now()
		Object.keys(self.presences).forEach( function (entity) {
			Object.keys(self.presences[entity]).forEach( function (node) {
				if ( self.presences[entity][node].timestamp <= timestamp - self.keeperInterval ) {
					delete self.presences[entity][node]
					self.logger.darconlog( null, `Presence of ${entity} is missing`, {}, 'debug' )
				}
			} )

			if ( Object.keys( self.presences[entity] ).length === 0 )
				if ( self.entityDisappeared )
					self.entityDisappeared( self, entity ).catch( (err) => { self.logger.darconlog(err) } )
		} )
	},

	async sendOut ( socketName, packet ) {
		let packetBin = jc.encode( this.strict ? await newPacket( packet ) : packet )

		if ( packetBin.length >= this.maxCommSize )
			throw BaseErrors.PacketExceeded( { limit: this.maxCommSize } )

		if ( packetBin.length < this.commSize ) {
			let h = NATS.headers()
			h.append(H_UID, packet.uid)
			await this.natsServer.publish( socketName, packetBin, { headers: h } )
			this.logger[ this.logLevel ]( { darcon: this.name, nodeID: this.nodeID, packet: packet.uid, flowID: packet.comm.flowID, processID: packet.comm.processID, sent: packet } )
		}
		else {
			let chunks = chunk( packetBin, this.commSize )
			for ( let i = 0; i < chunks.length; ++i ) {
				let h = NATS.headers()
				h.append(H_CHUNK_NO, i + 1)
				h.append(H_CHUNK_COUNT, chunks.length)
				h.append(H_UID, packet.uid)
				await this.natsServer.publish( socketName, packetBin, { headers: h } )
			}
			this.logger[ this.logLevel ]( { darcon: this.name, nodeID: this.nodeID, packet: packet.uid, flowID: packet.comm.flowID, processID: packet.comm.processID, sent: { chunks: chunks.length } } )
		}
	},

	async innercomm (mode, flowID, processID, source, sourceNodeID, entity, message, delegateEntity, delegateMessage, delegateErrorMessage, params, terms = {}) {
		if (mode === MODE_DELEGATE) {
			if ( !_.isString(delegateEntity) || !_.isString(delegateMessage) || !_.isString(delegateErrorMessage) )
				throw BaseErrors.DelegationRequired( { mode: MODE_DELEGATE } )
		}

		let nodeID = this._randomNodeID( entity, message )
		let socketName = entity + SEPARATOR + nodeID

		return this._innercomm(socketName, mode, flowID, processID, source, sourceNodeID, entity, message, delegateEntity, delegateMessage, delegateErrorMessage, params, terms)
	},
	async whisper (flowID, processID, source, sourceNodeID, entity, message, delegateEntity, delegateMessage, delegateErrorMessage, params, terms = {}) {
		let ids = this.presences[ entity ] ? Object.keys( this.presences[ entity ] ) : []
		if (!ids.includes(this.nodeID) ) ids.push( this.nodeID )

		for (let id of ids) {
			let socketName = entity + SEPARATOR + id
			await this._innercomm(socketName, MODE_INFORM, flowID, processID, source, sourceNodeID, entity, message, delegateEntity, delegateMessage, delegateErrorMessage, params, terms)
		}
		return OK
	},

	async _innercomm (socketName, mode, flowID, processID, source, sourceNodeID, entity, message, delegateEntity, delegateMessage, delegateErrorMessage, params, terms = {}) {
		let self = this

		let uid = self.clerobee.generate( )

		if (!params) params = []
		if (!Array.isArray(params)) throw BaseErrors.InvalidType( { attribute: 'params', entity, message } )
		let packet = {
			uid,
			comm: {
				mode,

				uid,

				flowID: flowID || self.clerobee.generate(),
				processID: processID || self.clerobee.generate(),

				creationDate: Date.now(),

				source,
				sourceNodeID,

				entity,
				message,
				delegateEntity, delegateMessage, delegateErrorMessage,

				params: params || [],

				terms: terms || {}
			}
		}

		return new Promise( (resolve, reject) => {
			if ( packet.comm.mode === MODE_REQUEST ) {
				let callback = function ( err, res ) {
					delete self.messages[ packet.uid ]
					if (err) return reject(err)
					resolve(res)
				}
				self.messages[ packet.uid ] = {
					timestamp: Date.now(),
					callback,
					entity: packet.comm.entity,
					message: packet.comm.message
				}
			}
			packet.comm.dispatchDate = Date.now()

			self.sendOut( socketName, packet ).then( () => {
				if ( packet.comm.mode !== MODE_REQUEST ) resolve( OK )
			} ).catch( (err) => {
				self.logger.darconlog(err)
				reject(err)
			} )

			return OK
		} )
	},

	async comm (mode, flowID, processID, entity, message, params, terms) {
		return this.innercomm(mode, flowID, processID, GATER, this.nodeID, entity, message, null, null, null, params, terms)
	},

	async inform (flowID, processID, entity, message, params, terms) {
		return this.innercomm(MODE_INFORM, flowID, processID, GATER, this.nodeID, entity, message, null, null, null, params, terms)
	},
	async delegate (flowID, processID, entity, message, delegateEntity, delegateMessage, delegateErrorMessage, params, terms) {
		return this.innercomm(MODE_DELEGATE, flowID, processID, GATER, this.nodeID, entity, message, delegateEntity, delegateMessage, delegateErrorMessage, params, terms)
	},
	async request (flowID, processID, entity, message, params, terms) {
		return this.innercomm(MODE_REQUEST, flowID, processID, GATER, this.nodeID, entity, message, null, null, null, params, terms)
	}

} )

module.exports = Darcon
