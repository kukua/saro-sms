import path from "path";
import _ from "lodash";
import Bunyan from "bunyan";
import bunyanDebugStream from "bunyan-debug-stream";
import parallel from "node-parallel";
import request from "request";
import moment from "moment-timezone";
import parse from "xml-parser";
import Twilio from "twilio";
import i18next from "i18next";

require( "dotenv" ).config();

const englishTrans = require( path.resolve( "locales/en" ) );
const swahilliTrans = require( path.resolve( "locales/sw" ) );
const sendersList = require( path.resolve( process.env.SENDERS_DB_PATH ) );
const recipientsDailyForecastList = require( path.resolve( process.env.RECIPIENTS_DAILY_DB_PATH ) );
const recipientsFourDayForeCastList = require( path.resolve( process.env.RECIPIENTS_FOUR_DAY_DB_PATH ) );

const twilio = new Twilio( process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN );
const senderID = String( process.env.SENDER_ID || "" );
const sendInterval = Number( process.env.SEND_INTERVAL_MS ) || 30000;
const p = parallel().timeout( 4 * 60 * 60 * 1000 );

const today = moment.utc().startOf( "day" );
const tomorrow = today.clone().add( 1, "day" );

const log = Bunyan.createLogger( {
    name: "saro-sms",
    streams: [
        {
            level: "info",
            type: "raw",
            stream: bunyanDebugStream( {
                basepath: path.resolve( "." ),
                forceColor: true,
            } ),
        },
        {
            level: "debug",
            type: "file",
            path: process.env.LOG_PATH,
        },
    ],
} );

log.level( "debug" );

i18next.init( {
    lng: "en",
    debug: false,
    resources: {
        en: {
            translation: englishTrans,
        },
        sw: {
            translation: swahilliTrans,
        },
    },
} );

function error( ...args ) {
    log.error( ...args );
    process.exit( 1 );
}

function findMeasurementForDateTime( measurements, date, time = "00:00" ) {
    const dateString = date.format( "YYYY-MM-DD" );
    const measurement = _.find( measurements, child => child.name === "fc" && child.attributes.dt === `${ dateString } ${ time }` );

    if ( measurement ) return measurement.attributes;

    return null;
}

function prefixWithLocation( location, text, separator = " " ) {
    if ( location.length + separator.length + text.length <= 160 ) {
        return `${ location }${ separator }${ text }`;
    }

    return `${ location.substr( 0, 160 - separator.length - text.length - 1 /* dot */ ) }.${ separator }${ text }`;
}

function createTextLineFormat1( prefix, m ) {
    return `${ prefix } rain ${ Math.ceil( m.pr ) }mm ${ m.pp }% temp ${ m.t }C wind ${ m.wn } ${ Math.round( m.ws * 3.6 ) }kmh hum ${ m.rh }%`;
}

function probability( percentage ) {
    if ( percentage <= 0.10 ) return "no";
    if ( percentage <= 0.50 ) return "small";
    if ( percentage > 0.50 ) return "high";
    return "unknown";
}

function intensity( mm ) {
    if ( mm <= 0 ) return "no";
    if ( mm <= 10 ) return "light";
    if ( mm > 10 ) return "heavy";
    return "unknown";
}

function createTextLineFormat2( prefix, m ) {
    return `${ prefix } ${ probability( m.pp ) } chance ${ intensity( m.pr ) } rain.`;
}

function createTextLineFormat3( afternoon, night ) {
    return `${ ( Math.ceil( afternoon.pr ) + Math.ceil( night.pr ) ) / 2 }mm ${ ( Math.ceil( afternoon.pp ) + Math.ceil( night.pp ) ) / 2 }%`;
}

function createTextLineFormat4( prefix ) {
    return `Unapokea ujumbe wa ${ prefix } ambalo lina mvua na uwezekano, joto la juu na la chini. Ikiwa haya si sahihi tafadhali ujumbe 0758659166`;
}

function sendText( from, to, text, cb ) {
    log.debug( {
        type: "sending", from, to, text,
    }, "" );

    twilio.messages.create( {
        from,
        to,
        body: text,
    }, ( err, result ) => {
        const sid = ( result ? result.sid : null );
        log.debug( {
            type: "sent", to, success: !err, sid,
        }, ( err && err.message ) || "" );
        cb( err );
    } );
}

function measurementsForDate( date, body, recipient, callback ) {
    const data = parse( body );
    const measurements = _( data ).get( "root.children.0.children" );
    const night = findMeasurementForDateTime( measurements, date, "00:00" );
    const morning = findMeasurementForDateTime( measurements, date, "06:00" );
    const afternoon = findMeasurementForDateTime( measurements, date, "12:00" );
    const evening = findMeasurementForDateTime( measurements, date, "18:00" );

    if ( !night || !morning || !afternoon || !evening ) {
        const err = "Expected night, morning, afternoon and evening measurement.";
        log.error( { recipient, body }, err );
        return callback( err );
    }

    return {
        night, morning, afternoon, evening,
    };
}

function getFTimes( format ) {
    if ( format === 1 || format === 2 ) {
        return "&ftimes=72/6h/-24";
    }

    return "&ftimes=96/12h/-12";
}

function getRangeOfDates( startDate, endDate ) {
    const dates = [ startDate ];

    const currDate = moment( startDate ).startOf( "day" );
    const lastDate = moment( endDate ).startOf( "day" );

    while ( currDate.add( 1, "days" ).diff( lastDate ) < 0 ) {
        dates.push( currDate.clone() );
    }

    dates.push( endDate );

    return dates;
}

function getFourDayForecast( body, recipient ) {
    const data = parse( body );
    const measurements = _( data ).get( "root.children.0.children" );
    const toDate = today.clone().add( 3, "day" );
    const range = getRangeOfDates( today, toDate );
    let text = "";

    // set locale
    i18next.changeLanguage( recipient.language );

    range.forEach( ( date, index ) => {
        const night = findMeasurementForDateTime( measurements, date, "00:00" );
        const afternoon = findMeasurementForDateTime( measurements, date, "12:00" );
        const dateText = `${ date.format( "dddd" ) }`;
        const dateTextTranslated = i18next.t( dateText );
        let newText = "";

        if ( index < 1 ) {
            newText = [
                dateTextTranslated,
                `${ createTextLineFormat3( afternoon, night ) } ${ i18next.t( "Afternoon" ) } ${ afternoon.t }C ${ i18next.t( "Night" ) } ${ night.t }C`,
            ].join( ":" );
        } else {
            newText = [
                dateTextTranslated,
                `${ createTextLineFormat3( afternoon, night ) } ${ afternoon.t }C ${ night.t }C`,
            ].join( ":" );
        }

        text = `${ text } ${ newText }`;
    } );

    text = `${ recipient.location },${ text }`;
    return text;
}

function sendDailyForecast() {
    sendForeCast( recipientsDailyForecastList );
}

function sendFourDayForecast() {
    sendForeCast( recipientsFourDayForeCastList );
}

function sendMonthlyMemo() {
    const recipientsForecastList = recipientsDailyForecastList.concat( recipientsFourDayForeCastList );

    sendForeCast( recipientsForecastList, false );
}

function sendForeCast( recipientsList, isNotMonthly = true ) {
    try {
        const validNumber = /^\+[0-9]{11,13}$/;

        sendersList.forEach( ( number ) => {
            if ( !number.match( validNumber ) ) {
                return error( { number }, "Invalid sender Twilio number." );
            }
            return true;
        } );

        const recipients = recipientsList.map( ( recipient, i ) => {
            const newRecipient = recipient;
            const twilioNumber = sendersList[ i % sendersList.length ];

            // Do validation, Note: recipient.name is optional
            if ( !recipient.location ) return error( { recipient }, "Missing recipient location." );
            if ( !recipient.number ) return error( { recipient }, "Missing recipient number." );
            if ( !recipient.latitude ) return error( { recipient }, "Missing recipient latitude." );
            if ( !recipient.longitude ) return error( { recipient }, "Missing recipient longitude." );
            if ( !recipient.number.match( validNumber ) ) return error( { recipient }, "Invalid recipient number." );
            if ( !twilioNumber ) return error( { recipient }, "Invalid recipient Twilio number." );

            newRecipient.name = ( recipient.name || "Unnamed" ).toUpperCase().trim();
            newRecipient.language = ( recipient.language || "en" ).trim();
            newRecipient.location = recipient.location.toUpperCase().trim();
            newRecipient.twilioNumber = twilioNumber;
            newRecipient.format = ( typeof recipient.format === "number" ? recipient.format : 1 );

            return newRecipient;
        } );

        // console.log(senders, recipients); process.exit(1)

        recipients.forEach( ( recipient, i ) => {
            p.add( ( done ) => {
                setTimeout( () => {
                    if ( isNotMonthly ) {
                        const url = `${ process.env.NAVIFEED_URL }${ getFTimes( recipient.format ) }&lat=${ recipient.latitude }&lon=${ recipient.longitude }`;

                        request( {
                            method: "GET",
                            url,
                            headers: {
                                Accept: "text/xml",
                            },
                        }, ( err, res, body ) => {
                            if ( err ) return error( err );

                            try {
                                log.debug( { type: "raw", recipient, body } );

                                if ( recipient.format === 1 ) {
                                    const { morning, afternoon, evening } = measurementsForDate( today, body, recipient, done );

                                    const text = prefixWithLocation( recipient.location, [
                                        `${ today.format( "MMM D" ) }`,
                                        createTextLineFormat1( "Morn", morning ),
                                        createTextLineFormat1( "Aft", afternoon ),
                                        createTextLineFormat1( "Eve", evening ),
                                    ].join( "\n" ) );

                                    sendText( senderID, recipient.number, text, done );
                                } else if ( recipient.format === 2 ) {
                                    const { night, morning, afternoon, evening } = measurementsForDate( tomorrow, body, recipient, done );

                                    const text = prefixWithLocation( recipient.location, [
                                        `${ tomorrow.format( "MMM D" ) }`,
                                        createTextLineFormat2( "Night", night ),
                                        createTextLineFormat2( "Morning", morning ),
                                        createTextLineFormat2( "Afternoon", afternoon ),
                                        createTextLineFormat2( "Evening", evening ),
                                    ].join( "\n" ) );

                                    sendText( recipient.twilioNumber, recipient.number, text, done );
                                } else if ( recipient.format === 3 ) {
                                    const text = getFourDayForecast( body, recipient );

                                    sendText( recipient.twilioNumber, recipient.number, text, done );
                                }
                            } catch ( e ) {
                                done( e );
                            }
                        } );
                    } else {
                        const text = createTextLineFormat4( recipient.location );

                        sendText( recipient.twilioNumber, recipient.number, text, done );
                    }
                }, i * sendInterval );
            } );
        } );

        p.done( ( err ) => {
            if ( err ) return error( err );
            log.info( "Done." );
        } );
    } catch ( err ) {
        error( err );
    }
}

// get request to handle send SMS via process.argv
process.argv.forEach( ( val ) => {
    if ( val === "daily" ) {
        sendDailyForecast();
    } else if ( val === "fourday" ) {
        sendFourDayForecast();
    } else if ( val === "monthly" ) {
        sendMonthlyMemo();
    }
} );
