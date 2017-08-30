/**
 * Created by drouar_b on 27/04/2017.
 */

const express = require('express');
const router = express.Router();

let dash = require('../core/dash');
let m3u8 = require('../core/m3u8');
let stream = require('../core/stream');
let download = require('../core/download');
let transcoder = require('../core/transcoder');
let universal = require('../core/universal');
let proxy = require('../core/proxy');
let bodyParser = require('body-parser');

//Dash routes
router.get('/video/:/transcode/universal/start.mpd', dash.serve);
router.get('/video/:/transcode/universal/dash/:sessionId/:streamId/initial.mp4', dash.serveInit);
router.get('/video/:/transcode/universal/dash/:sessionId/:streamId/:partId.m4s', dash.serveChunk);

//m3u8 mode
router.get('/video/:/transcode/universal/start.m3u8', m3u8.saveSession);
router.get('/video/:/transcode/universal/session/:sessionId/base/index.m3u8', m3u8.serve);
router.get('/video/:/transcode/universal/session/:sessionId/:fileType/:partId.ts', m3u8.serveChunk);
router.get('/video/:/transcode/universal/session/:sessionId/:fileType/:partId.vtt', m3u8.serveSubtitles);

//Stream mode
router.get('/video/:/transcode/universal/start', stream.serve);
router.get('/video/:/transcode/universal/subtitles', stream.serveSubtitles);

//Universal endpoints
router.get('/video/:/transcode/universal/stop', universal.stopTranscoder);
router.get('/video/:/transcode/universal/ping', universal.ping);
router.get('/:/timeline', universal.timeline);

// Download files
router.get('/library/parts/:id1/:id2/file.*', download.serve);

//Transcoder progression
router.post('/video/:/transcode/session/:sessionId/seglist', bodyParser.text({ type: function () {return true} }), transcoder.seglistParser);
router.post('/video/:/transcode/session/:sessionId/*/seglist', bodyParser.text({ type: function () {return true} }), transcoder.seglistParser);
router.post('/video/:/transcode/session/:sessionId/manifest', bodyParser.text({ type: function () {return true} }), transcoder.manifestParser);
router.post('/video/:/transcode/session/:sessionId/*/manifest', bodyParser.text({ type: function () {return true} }), transcoder.manifestParser);

// Reverse all others to plex
router.all('*', bodyParser.raw({ type: function () {return true} }), proxy);

module.exports = router;