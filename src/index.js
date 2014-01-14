var app = require('./app'),
    util = require('./util'),
    config = require('./config'),
    logger = require('./logger')(module);

if (process.env.NODE_ENV === 'production') {
    var worker = require('luster'),
        leData = require('./le-data');

    app.run(worker).then(function() {
        worker.registerRemoteCommand('reloadCache', function(target, workerId) {
            logger.info('worker %s receive message reloadCache initialized by worker %s', target.wid, workerId);
            leData.dropCache();
        });
    });
} else {
    util.createDirectory(config.get('app:logger:dir')).then(app.run);
}