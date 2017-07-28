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
		recipient.format = (typeof recipient.format === 'number' ? recipient.format : 1)

		if ( ! recipient.number.match(validNumber)) return error({ recipient }, 'Invalid recipient number.')
		if ( ! recipient.twilio_number) return error({ recipient }, 'Invalid recipient Twilio number.')

		return recipient
	})

	//console.log(senders, recipients); process.exit(1)

	const p = parallel().timeout(4 * 60 * 60 * 1000)
	const date = moment.utc().startOf('day')
	const tomorrow = date.clone().add(1, 'day')

	function findMeasurementForDateTime (measurements, date, time = '00:00') {
		const dateString = date.format('YYYY-MM-DD')
		const measurement = _.find(measurements, (child) => child.attributes.dt === `${dateString} ${time}`)

		if (measurement) return measurement.attributes
	}

	function prefixWithLocation (location, text, separator = ' ') {
		if (location.length + separator.length + text.length  <= 160) {
			return `${location}${separator}${text}`
		}

		return `${location.substr(0, 160 - separator.length - text.length - 1 /* dot */)}.${separator}${text}`
	}

	function createTextLineFormat1 (prefix, m) {
		return `${prefix} rain ${Math.ceil(m.pr)}mm ${m.pp}% temp ${m.t}C wind ${m.wn} ${Math.round(m.ws * 3.6)}kmh hum ${m.rh}%`
	}

	function probability (percentage) {
		if (percentage <= 0.10) return 'no'
		if (percentage <= 0.50) return 'small'
		if (percentage > 0.50) return 'high'
		return 'unknown'
	}

	function intensity (mm) {
		if (mm <= 0) return 'no'
		if (mm <= 10) return 'light'
		if (mm > 10) return 'heavy'
		return 'unknown'
	}

	function createTextLineFormat2 (prefix, m) {
		return `${prefix} ${probability(m.pp)} chance ${intensity(m.pr)} rain.`
	}

	function sendText (from, to, text, cb) {
		log.debug({ type: 'sending', from, to, text }, '')

		twilio.messages.create({
			from,
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

					function measurementsForDate (date) {
						var night     = findMeasurementForDateTime(measurements, date, '00:00')
						var morning   = findMeasurementForDateTime(measurements, date, '06:00')
						var afternoon = findMeasurementForDateTime(measurements, date, '12:00')
						var evening   = findMeasurementForDateTime(measurements, date, '18:00')

						if ( ! night || ! morning || ! afternoon || ! evening) {
							var err = 'Expected night, morning, afternoon and evening measurement.'
							log.error({ recipient, body }, err)
							return done(err)
						}

						return { night, morning, afternoon, evening }
					}


					var night, morning, afternoon, evening, text

					switch (recipient.format) {
					default:
					case 1:
						var { morning, afternoon, evening } = measurementsForDate(date)

						text = prefixWithLocation(recipient.location, [
							`${date.format('MMM D')}`,
							createTextLineFormat1('Morn', morning),
							createTextLineFormat1('Aft', afternoon),
							createTextLineFormat1('Eve', evening),
						].join('\n'))

						sendText(senderID, recipient.number, text, done)
						break
					case 2:
						var { night, morning, afternoon, evening } = measurementsForDate(tomorrow)

						text = prefixWithLocation(recipient.location, [
							`${tomorrow.format('MMM D')}`,
							createTextLineFormat2('Night', night),
							createTextLineFormat2('Morning', morning),
							createTextLineFormat2('Afternoon', afternoon),
							createTextLineFormat2('Evening', evening),
						].join('\n'))

						sendText(recipient.twilio_number, recipient.number, text, done)
						break
					}
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
