import path from 'path'
import _ from 'lodash'
import Bunyan from 'bunyan'
import bunyanDebugStream from 'bunyan-debug-stream'
import parallel from 'node-parallel'
import request from 'request'
import moment from 'moment-timezone'
import parse from 'xml-parser'
import Twilio from 'twilio'

require('dotenv').config()

const log = Bunyan.createLogger({
	name: 'saro-sms',
	streams: [
		{
			level: 'info',
			type: 'raw',
			stream: bunyanDebugStream({
				basepath: path.resolve('.'),
				forceColor: true,
			}),
		},
		{
			level: 'debug',
			type: 'file',
			path: process.env.LOG_PATH,
		},
	]
})

log.level('debug')

const twilio = new Twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN)
const senderID = String(process.env.SENDER_ID || '')
const sendInterval = Number(process.env.SEND_INTERVAL_MS) || 30000

function error (...args) {
	log.error(...args)
	process.exit(1)
}

try {
	const sendersFile = path.resolve(process.env.SENDERS_DB_PATH)
	const recipientsFile = path.resolve(process.env.RECIPIENTS_DB_PATH)
	const senders = require(sendersFile)
	var recipients = require(recipientsFile)
	const validNumber = /^\+[0-9]{11,13}$/

	senders.forEach((number) => {
		if ( ! number.match(validNumber)) return error({ number }, 'Invalid sender Twilio number.')
	})

	recipients = recipients.map((recipient, i) => {
		// Note: recipient.name is optional
		if ( ! recipient.location) return error({ recipient }, 'Missing recipient location.')
		if ( ! recipient.number) return error({ recipient }, 'Missing recipient number.')
		if ( ! recipient.latitude) return error({ recipient }, 'Missing recipient latitude.')
		if ( ! recipient.longitude) return error({ recipient }, 'Missing recipient longitude.')

		recipient.name = (recipient.name || 'Unnamed').toUpperCase().trim()
		recipient.location = recipient.location.toUpperCase().trim()
		recipient.twilio_number = senders[i % senders.length]

		if ( ! recipient.number.match(validNumber)) return error({ recipient }, 'Invalid recipient number.')
		if ( ! recipient.twilio_number) return error({ recipient }, 'Invalid recipient Twilio number.')

		return recipient
	})

	//console.log(senders, recipients); process.exit(1)

	const p = parallel().timeout(4 * 60 * 60 * 1000)
	const date = moment.utc().startOf('day')

	function findMeasurementForDateTime (measurements, date, time = '00:00') {
		const dateString = date.format('YYYY-MM-DD')
		const measurement = _.find(measurements, (child) => child.attributes.dt === `${dateString} ${time}`)

		if (measurement) return measurement.attributes
	}

	function createTextLine (prefix, m) {
		return `${prefix} rain ${Math.ceil(m.pr)}mm ${m.pp}% temp ${m.t}C wind ${m.wn} ${Math.round(m.ws * 3.6)}kmh hum ${m.rh}%`
	}

	function prefixWithLocation (location, text) {
		if (location.length + text.length + 1 /* space */ <= 160) {
			return `${location} ${text}`
		}

		return `${location.substr(0, 160 - text.length - 1 /* space */ - 1 /* dot */)}. ${text}`
	}

	function sendText (from, to, text, cb) {
		log.debug({ type: 'sending', from, to, text }, '')

		twilio.messages.create({
			from: senderID || from,
			to,
			body: text,
		}, (err, result) => {
			const sid = (result ? result.sid : null)
			log.debug({ type: 'sent', to, success: ! err, sid }, err && err.message || '')
			cb(err)
		})
	}

	recipients.forEach((recipient, i) => {
		p.add((done) => {
			setTimeout(() => {
				const url = `${process.env.NAVIFEED_URL}&lat=${recipient.latitude}&lon=${recipient.longitude}`

				request({
					method: 'GET',
					url,
					headers: {
						'Accept': 'text/xml',
					},
				}, (err, res, body) => {
					if (err) return error(err)

					log.debug({ type: 'raw', recipient, body })

					const data = parse(body)
					const measurements = _(data).get('root.children.0.children')

					const morning   = findMeasurementForDateTime(measurements, date, '06:00')
					const afternoon = findMeasurementForDateTime(measurements, date, '12:00')
					const evening   = findMeasurementForDateTime(measurements, date, '18:00')

					if ( ! morning || ! afternoon || ! evening) {
						const err = 'Expected morning, afternoon and evening measurement.'
						log.error({ recipient, body }, err)
						return done(err)
					}

					const text = prefixWithLocation(recipient.location, [
						`${date.format('MMM D')}`,
						createTextLine('Morn', morning),
						createTextLine('Aft', afternoon),
						createTextLine('Eve', evening),
					].join('\n'))

					sendText(recipient.twilio_number, recipient.number, text, done)
				})
			}, i * sendInterval)
		})
	})

	p.done((err) => {
		if (err) return error(err)
		log.info('Done.')
	})
} catch (err) {
	error(err)
}
