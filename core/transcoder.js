/**
 * Created by drouar_b on 27/04/2017.
 */

const child_process = require('child_process');
const debug = require('debug')('transcoder');
const fs = require('fs');
const rimraf = require('rimraf');
const request = require('request');
const xml2js = require('xml2js');
const config = require('../utils/config');
const redis = require('../utils/redis');
const utils = require('../utils/utils');
const proxy = require('./proxy');

class Transcoder {
    constructor(sessionId, req, res) {
        this.alive = true;
        this.ffmpeg = null;
        this.transcoding = true;
        this.sessionId = sessionId;
        this.redisClient = redis.getClient();

        debug('Create session ' + this.sessionId);
        this.timeout = setTimeout(this.PMSTimeout.bind(this), 20000);

        this.redisClient.on("message", () => {
            debug('Callback ' + this.sessionId);
            clearTimeout(this.timeout);
            this.timeout = undefined;

            this.redisClient.unsubscribe("__keyspace@" + config.redis_db + "__:" + this.sessionId);
            this.redisClient.get(this.sessionId, this.transcoderStarter.bind(this));
        });

        this.redisClient.subscribe("__keyspace@" + config.redis_db + "__:" + sessionId);

        if (typeof res != 'undefined') {
            proxy(req, res)
        } else {
            request(config.plex_url + req.url)
        }
    }

    transcoderStarter(err, reply) {
        if (err)
            return;

        rimraf.sync(config.xdg_cache_home + this.sessionId);
        fs.mkdirSync(config.xdg_cache_home + this.sessionId);

        let parsed = JSON.parse(reply);
        if (parsed == null) {
            debug(reply);
            return;
        }

        this.transcoderArgs = parsed.args;

        this.transcoderArgs = args.map((arg) => {
            return arg
                .replace('{URL}', "http://127.0.0.1:" + config.port)
                .replace('{SEGURL}', "http://127.0.0.1:" + config.port)
                .replace('{PROGRESSURL}', config.plex_url)
                .replace('{PATH}', config.mount_point)
                .replace('{SRTSRV}', config.srt_url)
                .replace(/\{USRPLEX\}/g, config.plex_ressources)
        });

        this.transcoderEnv = Object.create(process.env);
        this.transcoderEnv.LD_LIBRARY_PATH = config.ld_library_path;
        this.transcoderEnv.FFMPEG_EXTERNAL_LIBS = config.ffmpeg_external_libs;
        this.transcoderEnv.XDG_CACHE_HOME = config.xdg_cache_home;
        this.transcoderEnv.XDG_DATA_HOME = config.xdg_data_home;
        this.transcoderEnv.EAE_ROOT = config.eae_root;
        this.transcoderEnv.X_PLEX_TOKEN = parsed.env.X_PLEX_TOKEN;

        this.startFFMPEG();
    }

    startFFMPEG() {
        debug('Spawn ' + this.sessionId);
        this.ffmpeg = child_process.spawn(
            config.transcoder_path,
            this.transcoderArgs,
            {
                env: this.transcoderEnv,
                cwd: config.xdg_cache_home + this.sessionId + "/"
            });

        this.ffmpeg.on("exit", () => {
            debug('FFMPEG stopped ' + this.sessionId);
            this.transcoding = false
        });
    }

    PMSTimeout() {
        //TODO 500
        debug('Timeout ' + this.sessionId);
        this.timeout = undefined;
        this.killInstance();
    }

    killInstance() {
        debug('Killing ' + this.sessionId);
        this.redisClient.quit();
        this.alive = false;

        if (this.timeout != undefined) {
            clearTimeout(this.timeout)
        }

        if (this.ffmpeg != null && this.transcoding) {
            this.ffmpeg.kill('SIGKILL');
        }

        let cleaner = redis.getClient();
        cleaner.keys(this.sessionId + '*', (err, keys) => {
            if ((typeof keys != 'undefined') && keys.length > 0)
                cleaner.del(keys);
            cleaner.del(this.sessionId);
            cleaner.quit();
        });
    }

    segmentJumper(chunkId, streamId, rc) {
        rc.get(this.sessionId + ":last", (err, last) => {
            if (err || last == null || parseInt(last) > chunkId || parseInt(last) < chunkId - 10) {
                this.ffmpeg.kill('SIGKILL');
                this.transcoding = true;

                let prev = null;
                this.transcoderArgs.map((arg) => {
                    if (prev == '-segment_start_number' || prev == '-skip_to_segment') {
                        arg = (chunkId > 0 ? chunkId : 1);
                    }
                    prev = arg;
                    return arg;
                });

                rc.set(this.sessionId + ":" + streamId + ":last", utils.pad(chunkId, 5));
                this.startFFMPEG();
            }
        });
    }

    getChunk(chunkId, callback, streamId = '0') {
        let rc = redis.getClient();

        rc.get(this.sessionId + ":" + streamId + ":" + (chunkId == 'init' ? chunkId : utils.pad(chunkId, 5)), (err, chunk) => {
            if (chunk == null) {
                if (streamId != 'sub')
                    this.segmentJumper(chunkId, rc);

                if (this.transcoding) {
                    rc.on("message", () => {
                        callback(chunkId);
                        rc.quit();
                    });
                    rc.subscribe("__keyspace@" + config.redis_db + "__:" + this.sessionId + ":" + streamId + ":" + (chunkId == 'init' ? chunkId : utils.pad(chunkId, 5)))
                } else {
                    callback(-1);
                    rc.quit();
                }
            } else {
                callback(chunkId);
                rc.quit();
            }
        });
    }

    static seglistParser(req, res) {
        let last = -1;
        let rc = redis.getClient();

        req.body.split(/\r?\n/).forEach((itm) => {
            itm = itm.split(',');
            let chk = itm.shift();

            //Long polling
            if (chk.match(/chunk-[0-9]{5}/)) {
                rc.set(req.params.sessionId + ":0:" + chk.replace(/chunk-([0-9]{5})/, '$1'), itm.toString());
                last = parseInt(chk.replace(/chunk-([0-9]{5})/, '$1'));
            }
            if (chk.match(/sub-chunk-[0-9]{5}/)) {
                rc.set(req.params.sessionId + ":sub:" + chk.replace(/sub-chunk-([0-9]{5})/, '$1'), itm.toString())
            }

            //M3U8
            if (chk.match(/media-[0-9]{5}\.ts/)) {
                rc.set(req.params.sessionId + ":0:" + chk.replace(/media-([0-9]{5})\.ts/, '$1'), itm.toString());
                last = parseInt(chk.replace(/media-([0-9]{5})\.ts/, '$1'));
            }
            if (chk.match(/media-[0-9]{5}\.vtt/)) {
                rc.set(req.params.sessionId + ":sub:" + chk.replace(/media-([0-9]{5})\.vtt/, '$1'), itm.toString())
            }
        });

        if (last != -1) {
            rc.set(req.params.sessionId + ":last", last);
        }

        rc.quit();
        res.end();
    }

    static manifestParser(req, res) {
        xml2js.parseString(req.body, function (err, mpd) {
            if (err) {
                res.end();
                return;
            }
            let rc = redis.getClient();

            try {
                let last = -1;

                mpd.MPD.Period[0].AdaptationSet.forEach((adaptationSet) => {
                    let c = 0;
                    let i = 0;
                    let streamId = adaptationSet.Representation[0]["$"].id;

                    adaptationSet.Representation[0].SegmentTemplate[0].SegmentTimeline[0].S.forEach((s) => {
                        for (i = c; i < c + (typeof s["$"].r != 'undefined' ? parseInt(s["$"].r) : 1); i++) {
                            rc.set(req.params.sessionId + ":" + streamId + ":" + utils.pad(i, 5), s["$"].d);
                            if (i > last)
                                i = last;
                        }
                        c = i;
                    });
                });

                if (last != -1) {
                    rc.set(req.params.sessionId + ":last", last);
                }

                rc.quit();
            } catch (e) {
                rc.quit();
            }
            res.end();
        });
    }
}

module.exports = Transcoder;