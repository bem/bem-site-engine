var u = require('util'),
    path = require('path'),

    vow = require('vow'),
    fs = require('vow-fs'),
    _ = require('lodash'),
    sha = require('sha1'),

    logger = require('../../logger')(module),
    config = require('../../config'),
    util = require('../../util'),
    data = require('../data'),
    common = data.common;

var MSG = {
    WARN: {
        META_NOT_EXIST: 'source with lang %s does not exists for node %s',
        MD_NOT_EXIST: 'markdown with lang %s does not exists for node %s',
        META_PARSING_ERROR: 'source for lang %s contains errors for node %s',
        MD_PARSING_ERROR: 'markdown for lang %s contains errors for node %s',
        DEPRECATED: 'remove deprecated field %s for source user: %s repo: %s ref: %s path: %s'
    }
};

module.exports = {
    run: function() {
        logger.info('Collect docs start');

        var _sitemap;

        data.common.init();

        return common.loadData(common.PROVIDER_FILE, {
            path: path.resolve(config.get('data:sitemap:file'))
        })
        .then(function(sitemap) {
            _sitemap = sitemap;
            return collectNodesWithSource(sitemap);
        })
        .then(function(nodeWithSources) {
            return loadSourcesForNodes(nodeWithSources);
        })
        .then(function() {
            return saveAndUploadSitemap(_sitemap);
        })
        .then(
            function() {
                logger.info('Collect docs end successfully');
            },
            function() {
                logger.error('Error occur while saving and uploading data');
            }
        );
    }
};

/**
 * Collect nodes that have sources
 * @param sitemap - {Object} sitemap model
 * @returns {Array} - array of nodes
 */
var collectNodesWithSource = function(sitemap) {

    var nodesWithSource = [];

    /**
     * Recursive function for traversing tree model
     * @param node {Object} - single node of sitemap model
     */
    var traverseTreeNodes = function(node) {

        if(node.source) {
           nodesWithSource.push(node);
        }

        if(node.items) {
            node.items.forEach(function(item) {
                traverseTreeNodes(item);
            });
        }
    };

    sitemap.forEach(function(item) {
        traverseTreeNodes(item);
    });

    return nodesWithSource;
};

var loadSourcesForNodes = function(nodesWithSource) {
    logger.info('Load all docs start');

    var collected = {
        docs: [],
        authors: [],
        translators: [],
        tags: []
    };

    var LANG = {
        EN: 'en',
        RU: 'ru'
    };

    var promises = nodesWithSource.map(function(node) {
        return vow.allResolved({
            en: analyzeMetaInformation(node, LANG.EN, collected)
                .then(function(res) {
                    return loadMDFile(res.node, LANG.EN, res.repo);
                })
                .then(function(res) {
                    collected.docs.push({
                        id: node.source[LANG.EN].content,
                        source: res
                    });
                })
            ,
            ru: analyzeMetaInformation(node, LANG.RU, collected)
                .then(function(res) {
                    return loadMDFile(res.node, LANG.RU, res.repo);
                })
                .then(function() {
                    collected.docs.push({
                        id: node.source[LANG.RU].content,
                        source: res
                    });
                })
        })
    });

    return vow.allResolved(promises).then(function() {
        return saveAndUploadDocs(collected);
    });
};

var analyzeMetaInformation = function(node, lang, collected) {

    var def = vow.defer();

    if(!node.source[lang]) {
        logger.warn(MSG.WARN.META_NOT_EXIST, lang, node.title && (node.title[lang] || node.title));
        node.source[lang] = null;

        def.reject();
        return def.promise();
    }

    try {
        var meta = node.source[lang];

        //parse date from dd-mm-yyyy format into milliseconds
        if(meta.createDate) {
            meta.createDate = util.dateToMilliseconds(meta.createDate);
        }

        //parse date from dd-mm-yyyy format into milliseconds
        if(meta.editDate) {
            node.source[lang].editDate = util.dateToMilliseconds(meta.editDate);
        }

        //compact and collect authors
        if(meta.authors && _.isArray(meta.authors)) {
            meta.authors = _.compact(meta.authors);
            node.source[lang].authors = meta.authors;
            collected.authors = _.union(collected.authors, meta.authors);
        }

        //compact and collect translators
        if(meta.translators && _.isArray(meta.translators)) {
            meta.translators = _.compact(meta.translators);
            node.source[lang].translators = meta.translators;
            collected.translators = _.union(collected.translators, meta.translators);
        }

        //collect tags
        if(meta.tags) {
            collected.tags = _.union(collected.tags, meta.tags);
        }

        var content = meta.content;

        var repo = (function(_source) {
            var re = /^https?:\/\/(.+?)\/(.+?)\/(.+?)\/tree\/(.+?)\/(.+)/,
                parsedSource = _source.match(re);
            return {
                host: parsedSource[1],
                user: parsedSource[2],
                repo: parsedSource[3],
                ref: parsedSource[4],
                path: parsedSource[5]
            };
        })(content);

        logger.verbose('get repo from source user: %s repo: %s ref: %s path: %s',
            repo.user, repo.repo, repo.ref, repo.path);

        //set repo information
        node.source[lang].repo = {
            issue: u.format("https://%s/%s/%s/issues/new?title=Feedback+for+\"%s\"",
                repo.host, repo.user, repo.repo, meta.title),
            prose: u.format("http://prose.io/#%s/%s/edit/%s/%s",
                repo.user, repo.repo, repo.ref, repo.path)
        };

        def.resolve({ node: node, repo: repo });

    }catch(err) {
        logger.warn(MSG.WARN.META_PARSING_ERROR, lang, node.title && (node.title[lang] || node.title));

        node.source[lang] = null;
        def.reject();
    }

    return def.promise();
};

var loadMDFile = function(node, lang, repo) {
    return common.loadData(common.PROVIDER_GITHUB_API, { repository: repo })
        .then(function(md) {
            try {
                if(!md.res) {
                    logger.warn(MSG.WARN.MD_NOT_EXIST, lang, node.title);
                    md = null;
                }else {
                    md = (new Buffer(md.res.content, 'base64')).toString();
                    md = util.mdToHtml(md);
                }
            } catch(err) {
                logger.warn(MSG.WARN.MD_PARSING_ERROR, lang, node.title);
                md = null;
            }

            return md;
        });
};

/**
 * Creates backup object, save it into json file and
 * upload it via yandex disk api
 * @param docs - {Object} object with fields:
 * - id {String} unique id of node
 * - source {Object} source of node
 * @param collected - {Object} object with fields:
 * - authors {Array} - array of unique authors
 * - translators {Array} - array of unique translators
 * - tags {Array} - array of unique tags
 */
var saveAndUploadDocs = function(content) {
    logger.info('Save documentation to file and upload it');

    if ('production' === process.env.NODE_ENV) {
        return common.saveData(common.PROVIDER_YANDEX_DISK, {
            path: config.get('data:docs:disk'),
            data: JSON.stringify(content, null, 4)
        });
    }else {
        return common.saveData(common.PROVIDER_FILE, {
            path: config.get('data:docs:file'),
            data: content
        });
    }
};

var saveAndUploadSitemap = function(sitemap) {
    if ('production' === process.env.NODE_ENV) {
        return common.saveData(common.PROVIDER_YANDEX_DISK, {
            path: config.get('data:sitemap:disk'),
            data: JSON.stringify(sitemap, null, 4)
        });
    }else {
        return common.saveData(common.PROVIDER_FILE, {
            path: config.get('data:sitemap:file'),
            data: sitemap
        });
    }
};


