let NATS = require('nats')

const _ = require( 'isa.js' )

const Clerobee = require( 'clerobee' )

const Assigner = require( 'assign.js' )
let assigner = new Assigner()

const fs = require('fs')
const path = require('path')
let VERSION = exports.VERSION = JSON.parse( fs.readFileSync( path.join( __dirname, 'package.json'), 'utf8' ) ).version

let { MODE_REQUEST, MODE_INFORM, MODE_DELEGATE, CommPacketer, CommPresencer } = require( './models/Packet' )

const HIDDEN_SERVICES_PREFIX = '_'
const SERVICES_REPORTS = 'darcon_service_reports'
const UNDEFINED = 'ToBeFilled'
const SEPARATOR = '_'
const GATER = 'Gater'

const OK = 'OK'

let { Configurator } = require( './models/Configuration' )

let PinoLogger = require('./PinoLogger')


const {inherits} = require('util')
let DarconError = function (message, errorName, errorCode) {
	this.message = message
	this.errorName = errorName
	this.errorCode = errorCode
	Error.captureStackTrace(this, DarconError)
}
inherits(DarconError, Error)


let Services = {
	name: UNDEFINED,
	nodeID: UNDEFINED,

	_randomNodeID ( entity ) {
		if ( !this.presences || !this.presences[ entity ] )
			return null

		let ids = Object.keys( this.presences[ entity ] )
		let id = ids[ Math.floor( Math.random( ) * ids.length ) ]
		return id
	},
	async init (config = {}) { let self = this
		this.name = config.name || 'Daconer'
		config.logger = config.logger || PinoLogger( this.name, config.log )

		assigner.assign( self, await Configurator.derive( config ) )

		this.clerobee = new Clerobee( this.idLength )
		this.nodeID = this.clerobee.generate( ),

		this.presences = {}
		this.messages = {}
		this.ins = {}
		this.ins[ SERVICES_REPORTS ] = {
			name: SERVICES_REPORTS,
			entity: { name: SERVICES_REPORTS }
		}

		this.reporter = setInterval( () => { self.reportStatus() }, this.reporterInterval )
		this.keeper = setInterval( () => { self.checkPresence() }, this.keeperInterval )

		await this.connect( )

		await this.innerCreateIn( SERVICES_REPORTS, '', async function ( message ) {
			try {
				let present = await CommPresencer.derive( JSON.parse( message ) )

				if ( !self.presences[ present.entity ] )
					self.presences[ present.entity ] = {}

				self.presences[ present.entity ][ present.nodeID ] = {
					timestamp: Date.now(), projectVersion: present.projectVersion, entityVersion: present.entityVersion
				}
			} catch (err) { self.logger.darconlog( err ) }
		} )

		await this.publish( {
			name: GATER,
			version: VERSION
		} )
	},

	async publish (...entities) {
		let self = this
		for (let entity of entities) {
			if (entity.request) throw new Error('Entity already has a request function')
			entity.request = async function (to, message, ...params) {
				let terms = params[ params.length - 1 ]
				let rP = params.slice( 0, -1 )
				return self.innercomm(MODE_REQUEST, terms.comm.flowID, self.clerobee.generate( ), entity.name, self.nodeID, to, message, null, null, ...rP)
			}
			if (entity.inform) throw new Error('Entity already has a inform function')
			entity.inform = async function (to, message, ...params) {
				let terms = params[ params.length - 1 ]
				let rP = params.slice( 0, -1 )
				return self.innercomm(MODE_INFORM, terms.comm.flowID, self.clerobee.generate( ), entity.name, self.nodeID, to, message, null, null, ...rP)
			}
			if (entity.delegate) throw new Error('Entity already has a delegate function')
			entity.delegate = async function (to, message, delegateEntity, delegateMessage, ...params) {
				let terms = params[ params.length - 1 ]
				let rP = params.slice( 0, -1 )
				return self.innercomm(MODE_DELEGATE, terms.comm.flowID, self.clerobee.generate( ), entity.name, self.nodeID, to, message, delegateEntity, delegateMessage, ...rP)
			}

			if ( !this.ins[ entity.name ] )
				this.ins[ entity.name ] = {
					name: entity.name,
					version: entity.version || entity.VERSION || '1.0.0',
					services: _.functionNames( entity ).filter( (fnName) => { return !fnName.startsWith( HIDDEN_SERVICES_PREFIX ) } ),
					entity
				}

			await this.innerCreateIn( entity.name, this.nodeID, async function ( message ) {
				try {
					let incoming = await CommPacketer.derive( JSON.parse( message ) )
					if ( incoming.comm.response || incoming.comm.error ) {
						incoming.comm.receptionDate = Date.now()

						if ( !self.messages[ incoming.uid ] ) return OK
						self.messages[ incoming.uid ].callback(
							incoming.comm.error ? new DarconError( incoming.comm.error.message, incoming.comm.error.errorName, incoming.comm.error.errorcode ) : null,
							incoming.comm.error ? null : incoming.comm.response
						)
					}
					else {
						incoming.comm.arrivalDate = Date.now()

						incoming.comm.responderNodeID = self.nodeID
						try {
							let paramsToPass = incoming.comm.params.concat( [ {
								async request (to, message, ...params) {
									return self.innercomm(MODE_REQUEST, incoming.comm.flowID, incoming.comm.processID, incoming.comm.entity, self.nodeID, to, message, null, null, ...params)
								},
								async inform (to, message, ...params) {
									return self.innercomm(MODE_INFORM, incoming.comm.flowID, incoming.comm.processID, incoming.comm.entity, self.nodeID, to, message, null, null, ...params)
								},
								async delegate (to, message, delegateEntity, delegateMessage, ...params) {
									return self.innercomm(MODE_DELEGATE, incoming.comm.flowID, incoming.comm.processID, incoming.comm.entity, self.nodeID, to, message, delegateEntity, delegateMessage, ...params)
								},
								comm: incoming.comm
							} ] )
							incoming.comm.response = await self.ins[ incoming.comm.entity ].entity[ incoming.comm.message ]( ...paramsToPass )
						} catch (err) {
							incoming.comm.error = { message: err.message || err.toString(), code: err.code || err.errorCode || err.errorcode || '-1', errorName: err.errorName || '' }
						}

						if (incoming.comm.mode === MODE_INFORM) return OK

						if (incoming.comm.mode === MODE_DELEGATE) {
						}
						else {
							let socketName = incoming.comm.source + SEPARATOR + incoming.comm.sourceNodeID
							incoming.comm.responseDate = Date.now()
							self.nats.publish( socketName, JSON.stringify( incoming ) )
						}

						return OK
					}
				} catch (err) {
					console.error(err)
					self.logger.darconlog( err )
				}
			} )
		}
	},

	async connect () {
		let self = this

		return new Promise( (resolve, reject) => {
			self.logger.darconlog( null, 'Connecting to NATS:', self.nats.url, 'info' )

			try {
				self.nats = NATS.connect( self.nats )

				self.nats.on('connect', function (nc) {
					self.logger.darconlog( null, 'NATS connection is made', { }, 'warn' )
					resolve( OK )
				})
				self.nats.on('error', (err) => {
					self.logger.darconlog( err )
				} )
				self.nats.on('close', () => {
					self.logger.darconlog( null, 'NATS connection closed')
				} )
				self.nats.on('disconnect', function () {
					self.logger.darconlog( null, 'NATS disconnected')
				})

				self.nats.on('reconnecting', function () {
					self.logger.darconlog( null, 'NATS reconnecting...')
					self.resetup().catch( (err) => { self.logger.darconlog(err) } )
				})

				self.nats.on('reconnect', function (nc) {
					self.logger.darconlog( null, 'NATS reconnected')
				})

				if ( self.tolerance > 0 ) {
					self.cleaner = setInterval( function () {
						self.cleanupMessages()
					}, self.tolerance )
				}
			} catch (err) { reject(err) }
		} )
	},

	async close () {
		var self = this
		return new Promise( async (resolve, reject) => {
			self.finalised = true

			if (self.reporter)
				clearInterval( self.reporter )
			if (self.keeper)
				clearInterval( self.keeper )
			if (self.cleaner)
				clearInterval( self.cleaner )

			try {
				if ( self.nats )
					self.nats.close()
				resolve( OK )
			} catch (err) {
				reject(err)
			}
		} )
	},


	async innerCreateIn ( entityName, node, handler ) {
		let self = this

		let socketName = entityName + (node ? SEPARATOR + node : node)
		self.nats.subscribe( socketName, (message) => {
			handler(message).catch( (err) => {
				console.error(err)
				self.logger.darconlog(err) } )
			return OK
		} )

		self.logger.darconlog( null, 'NATS SUBSCRIBE is made.', { entityName, node }, 'info' )
	},

	async cleanupMessages () {
		let self = this

		console.log('---------', self.tolerance)
		let time = Date.now()
		for ( let key of Object.keys( self.messages ) ) {
			if ( time - self.messages[key].timestamp > self.tolerance ) {
				let callbackFn = self.messages[key].callback
				let entity = self.messages[key].entity
				let message = self.messages[key].message
				delete self.messages[ key ]
				callbackFn( new Error( `Response timeout to ${entity} ${message}` ) )
			}
		}
	},

	async reportStatus () {
		let self = this

		try {
			for (let name in this.ins) {
				if (name === SERVICES_REPORTS || name === GATER) continue

				let entity = this.ins[ name ]
				self.nats.publish( SERVICES_REPORTS, JSON.stringify( await CommPresencer.derive( {
					entity: entity.name,
					nodeID: self.nodeID,
					entityVersion: entity.version
				} ) ) )
			}
		} catch ( err ) { self.logger.darconlog( err ) }
	},

	async resetup ( ) {
		let self = this

		for ( let ref of Object.keys(self.ins) )
			await this.publish( ref.entity )

		return OK
	},

	async checkPresence () {
		let self = this

		let timestamp = Date.now()
		Object.keys(self.presences).forEach( function (entity) {
			Object.keys(self.presences[entity]).forEach( function (node) {
				if ( self.presences[entity][node].timestamp <= timestamp - self.keeperInterval )
					delete self.presences[entity][node]
			} )
		} )
	},

	async innercomm (mode, flowID, processID, source, sourceNodeID, entity, message, delegateEntity, delegateMessage, ...params) {
		let self = this

		let nodeID = this._randomNodeID( entity )
		let socketName = entity + SEPARATOR + nodeID

		let packet = await CommPacketer.derive( {
			comm: {
				mode,

				uid: self.clerobee.generate( ),

				flowID: flowID || self.clerobee.generate(),
				processID: processID || self.clerobee.generate(),

				creationDate: Date.now(),

				source,
				sourceNodeID,

				entity,
				message,
				delegateEntity, delegateMessage,

				params
			}
		} )

		return new Promise( (resolve, reject) => {
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
			packet.comm.dispatchDate = Date.now()
			this.nats.publish( socketName, JSON.stringify( packet ) )

			return OK

		} )
	},

	async comm (mode, flowID, processID, entity, message, ...params) {
		return this.innercomm(mode, flowID, processID, GATER, this.nodeID, entity, message, null, null, ...params)
	}

}

module.exports = Services