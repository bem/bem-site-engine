var path = require('path'),
    vow = require('vow'),

    util = require('../util'),
    config = require('../config'),
    logger = require('../logger')(module),
    providers = require('../providers');

var SEARCH = {
    PING: '/__search/ping',
    LIBS: '/__search/libs',
    BLOCKS: '/__search/blocks'
};

module.exports = function() {
    return function(req, res, next) {
        /**
         * Loads files from local filesystem
         * or Yandex Disk depending on environment
         * @param key - {String} config key
         * @returns {*}
         */
        var load = function(key) {
                var provider = util.isDev() ? providers.getFileProvider() : providers.getYaDiskProvider(),
                    opts = { path: path.join(config.get('common:model:dir'),
                        util.isDev() ? '' : config.get('NODE_ENV'), config.get(key))
                    };

                return provider.load(opts).then(res.end);
            },
            url = req.path;

        if(url.indexOf(SEARCH.PING) > -1) {
            return load('common:model:marker');
        }else if(url.indexOf(SEARCH.LIBS) > -1){
            return load('common:model:search:libraries');
        }else if(url.indexOf(SEARCH.BLOCKS) > -1){
            return load('common:model:search:blocks');
        }else {
            return next();
        }
    };
};
