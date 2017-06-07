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

function error (...args) {
	log.error(...args)
	process.exit(1)
}

try {
	const numbersFile = path.resolve(process.env.NUMBERS_DB_PATH)
	const numbers = require(numbersFile)

	const recipients = _(numbers)
		.map((list) => {
			if ( ! Array.isArray(list.recipients)) return error({ recipients }, 'Recipients not an array.')
			if ( ! list.twilio_number) return error({ list }, 'Missing Twilio number.')

			list.recipients.forEach((recipient) => {
				// Note: recipient.name is optional
				if ( ! recipient.location) return error({ recipient }, 'Missing recipient location.')
				if ( ! recipient.number) return error({ recipient }, 'Missing recipient number.')
				if ( ! recipient.latitude) return error({ recipient }, 'Missing recipient latitude.')
				if ( ! recipient.longitude) return error({ recipient }, 'Missing recipient longitude.')

				recipient.twilio_number = list.twilio_number
			})

			return list.recipients
		})
		.flatten()
		.value()

	//console.log(recipients)

	const p = parallel().timeout(5 * 60 * 1000)
	const tomorrow = moment.utc().startOf('day').add(1, 'day')
	const tomorrowDate = tomorrow.format('YYYY-MM-DD')

	function createTextLine (prefix, m) {
		return `${prefix} rain ${Math.ceil(m.pr)}mm ${m.pp}% temp ${m.t}C wind ${m.wn} ${Math.round(m.ws * 3.6)}kmh hum ${m.rh}%`
	}

	function prefixWithLocation (location, text) {
		location = location.toUpperCase()

		if (location.length + text.length + 1 /* space */ <= 160) {
			return `${location} ${text}`
		}

		return `${location.substr(0, 160 - text.length - 1 /* space */ - 1 /* dot */)}. ${text}`
	}

	function sendText (from, to, text, cb) {
		log.debug({ type: 'sending', from, to, text }, '')

		twilio.messages.create({
			from,
			to,
			body: text,
		}, (err, result) => {
			log.debug({ type: 'sent', to, success: ! err, sid: result.sid }, err && err.message || '')
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

					const data = parse(body)
					const measurements = _(data)
						.get('root.children.0.children')
						.filter((child) => child.name === 'fc' && child.attributes.dt.startsWith(tomorrowDate))
						.map((child) => child.attributes)

					if (measurements.length !== 4) {
						log.error({ recipient, body }, 'Expected 4 measurements.')
						return done('Expected 4 measurements.')
					}

					measurements.shift()

					const text = prefixWithLocation(recipient.location, [
						`${tomorrow.format('MMM D')}`,
						createTextLine('Morn', measurements[0]),
						createTextLine('Aft', measurements[1]),
						createTextLine('Eve', measurements[2]),
					].join('\n'))

					sendText(recipient.twilio_number, recipient.number, text, done)
				})
			}, 100 * i) // 10 per second
		})
	})

	p.done((err) => {
		if (err) return error(err)
		log.info('Done.')
	})
} catch (err) {
	error(err)
}
