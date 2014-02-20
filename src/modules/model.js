var u = require('util'),
    path = require('path'),

    vow = require('vow'),
    fs = require('vow-fs'),
    _ = require('lodash'),
    sha = require('sha1'),
    susanin = require('susanin'),

    logger = require('../logger')(module),
    config = require('../config'),
    constants = require('./constants'),
    nodes = require('./nodes'),
    data = require('./data');

var sitemap,
    routes = {};

module.exports = {
    init: function() {
        logger.info('Init site structure and load data');

        data.common.init();

        return data.common.loadData(data.common.PROVIDER_FILE, {
                path: path.join('configs', 'common', 'sitemap.json')
            })
            .then(function(content) {
                sitemap = content;
                return createModel(sitemap);
            })
            .then(function(res) {
                return vow.all([
                    data.docs.load(res.docs),
                    data.libraries.load(res.libs),
                    data.people.load()
                ]).then(function() {
                    return res;
                });
            })
            .then(function(res) {
                return vow.all([
                    addLibraryNodes(res.libs),
                    addDynamicNodes()
                ]);
            });
    },

    /**
     * Returns array of objects for susanin routes creation
     * @returns {Array}
     */
    getRoutes: function() {
        return _.values(routes);
    },

    /**
     * Returns parsed and post-processed sitemap model
     * @returns {Object}
     */
    getSitemap: function() {
        return sitemap;
    }
};

var setSiteMap = function(_sitemap) {
    sitemap = _sitemap;
};

var createModel = function(sitemap) {
    logger.info('Process site map');

    var def = vow.defer(),
        nodesWithSource = [],
        nodesWithLib = [],

        /**
         * Collects routes rules for nodes
         * @param node {Object} - single node of sitemap model
         * @param level {Number} - menu deep level
         */
        processRoute = function(node, level) {
            node.params = _.extend({}, node.parent.params);
            node.level = level;

            if(!node.route) {
                node.route = {
                    name: node.parent.route.name
                };
                node.type = node.type ||
                    (node.url ? node.TYPE.SIMPLE : node.TYPE.GROUP);
                return;
            }

            var r = node.route;

            if(r[constants.ROUTE.NAME]) {
                routes[r.name] = routes[r.name] || { name: r.name, pattern: r.pattern };
                node.url = susanin.Route(routes[r.name]).build(node.params);
            }else {
                r.name = node.parent.route.name;
            }

            [constants.ROUTE.DEFAULTS, constants.ROUTE.CONDITIONS, constants.ROUTE.DATA].forEach(function(item) {
                routes[r.name][item] = routes[r.name][item] || {};

                if(r[item]) {
                    Object.keys(r[item]).forEach(function(key) {
                        if(item === constants.ROUTE.CONDITIONS) {
                            routes[r.name][item][key] = routes[r.name][item][key] || [];
                            routes[r.name][item][key].push(r[item][key]);

                            node.url = susanin.Route(routes[r.name]).build(_.extend(node.params, r[item]));
                        }else {
                            routes[r.name][item][key] = r[item][key];
                        }
                    });
                }
            });

            node.type = node.type || node.TYPE.SIMPLE;
        },

        /**
         * Recursive function for traversing tree model
         * @param node {Object} - single node of sitemap model
         * @param parent {Object} - parent for current node
         * @param level {Number} - menu deep level
         */
        traverseTreeNodes = function(node, parent, level) {

            node = new nodes.base.BaseNode(node, parent);

            processRoute(node, level);

            if(node.source) {
                nodesWithSource.push(node);
            }
            if(node.lib) {
                nodesWithLib.push(node);
            }

            logger.verbose('id = %s level = %s url = %s source = %s',
                    node.id, node.level, node.url, node.source);

            //deep into node items
            if(node.items) {
                node.items = node.items.map(function(item) {
                    return traverseTreeNodes(item, node,
                        node.type === node.TYPE.GROUP ? level : level + 1);
                });
            }

            return node;
        };

    try {
        setSiteMap(sitemap.map(function(item) {
            return traverseTreeNodes(item, {
                route: { name: null },
                params: {}
            }, 0);
        }));

        def.resolve({
            docs: nodesWithSource,
            libs: nodesWithLib
        });
    } catch(e) {
        logger.error(e.message);
        def.reject(e);
    }

    return def.promise();
};

/**
 * Dynamic addition of nodes for authors, translators and tags
 * grouped menu items
 */
var addDynamicNodes = function() {
    logger.info('Add dynamic nodes to sitemap');

    var addDynamicNodesFor = function(_config) {
        logger.debug('add dynamic nodes for %s', _config.key);

        var def = vow.defer(),
            targetNode,
            baseRoute;

        try {
            targetNode = findNodeByCriteria('dynamic', _config.key);

            if(!targetNode) {
                logger.warn('target node for %s was not found', _config.key);

                def.resolve();
                return def.promise();
            }

            baseRoute = targetNode.getBaseRoute();

            targetNode.items = targetNode.items || [];
            routes[baseRoute.name].conditions = routes[baseRoute.name].conditions || {};

            _config.data.apply(null).forEach(function(item) {
                var conditions = {
                    conditions: {
                        id: item
                    }
                };

                Object.keys(conditions.conditions).forEach(function(key) {
                    routes[baseRoute.name].conditions[key] = routes[baseRoute.name].conditions[key] || [];
                    routes[baseRoute.name].conditions[key].push(conditions.conditions[key]);
                });

                var _node,
                    _route = {
                        route: _.extend({}, { name: baseRoute.name }, conditions),
                        url: susanin.Route(routes[baseRoute.name]).build(conditions.conditions)
                    };

                if('authors' === _config.key || 'translators' === _config.key) {
                    _node = new nodes.person.PersonNode(_route, targetNode, item);
                }else if('tags' === _config.key) {
                    _node = new nodes.tag.TagNode(_route, targetNode, item);
                }

                _config.urlHash[item] = _node.url;
                targetNode.items.push(_node);

                logger.verbose('add dynamic node for %s with id = %s level = %s url = %s',
                    _config.key, _node.id, _node.level, _node.url);

                def.resolve(_node);
            });
        }catch(err) {
            logger.error(err.message);
            def.reject(err);
        }

        return def.promise();
    };

    return vow.all([
        addDynamicNodesFor({
            key: 'authors',
            data: data.docs.getAuthors,
            urlHash: data.people.getUrls()
        }),
        addDynamicNodesFor({
            key: 'translators',
            data: data.docs.getTranslators,
            urlHash: data.people.getUrls()
        }),
        addDynamicNodesFor({
            key: 'tags',
            data: data.docs.getTags,
            urlHash: data.docs.getTagUrls()
        })
    ]);
};

var addLibraryNodes = function(nodesWithLib) {
    logger.info('add library nodes');

    var librariesRepository = config.get('github:librariesRepository');

    if(!nodesWithLib || !_.isArray(nodesWithLib) || nodesWithLib.length === 0) {
        logger.warn('nodes with lib not found');
        return;
    }

    var collectConditionsForBaseRoute = function(baseRoute, conditions) {
            Object.keys(conditions.conditions).forEach(function(key) {
                routes[baseRoute.name].conditions[key] = routes[baseRoute.name].conditions[key] || [];
                routes[baseRoute.name].conditions[key].push(conditions.conditions[key]);
            });
        },

        addVersionsToLibrary = function(targetNode) {
            logger.debug('add versions to library %s', targetNode.lib);

            var baseRoute = targetNode.getBaseRoute();

            routes[baseRoute.name].conditions = routes[baseRoute.name].conditions || {};
            targetNode.items = targetNode.items || [];

            var versions = data.libraries.getLibraries()[targetNode.lib];
            if(!versions) return;

            Object.keys(versions).forEach(function(key) {

                var version = versions[key],
                    conditions = {
                        conditions: {
                            lib: version.repo,
                            version: version.ref
                        }
                    };

                collectConditionsForBaseRoute(baseRoute, conditions);

                //create node
                var _route = {
                        route: _.extend({}, { name: baseRoute.name }, conditions),
                        url: susanin.Route(routes[baseRoute.name]).build(conditions.conditions)
                    },
                    _node = new nodes.version.VersionNode(_route, targetNode, version);

                targetNode.items.push(_node);

                addPostToVersion(_node, version, {
                    key: 'migration',
                    title: {
                        en: 'Migration',
                        ru: 'Migration'
                    }
                });
                addPostToVersion(_node, version, {
                    key: 'changelog',
                    title: {
                        en: 'Changelog',
                        ru: 'Changelog'
                    }
                });
                addLevelsToVersion(_node, version);
            });
        },

        addPostToVersion = function(targetNode, version, _config) {
            logger.debug('add post %s to version %s of library %s', _config.key, version.ref, version.repo);

            var baseRoute = targetNode.getBaseRoute();

            routes[baseRoute.name].conditions = routes[baseRoute.name].conditions || {};
            targetNode.items = targetNode.items || [];

            var conditions = {
                conditions: {
                    lib: version.repo,
                    version: version.ref,
                    id: _config.key
                }
            };

            collectConditionsForBaseRoute(baseRoute, conditions);

            //create node
            var _route = {
                    route: _.extend({}, { name: baseRoute.name }, conditions),
                    url: susanin.Route(routes[baseRoute.name]).build(conditions.conditions)
                },
                _node = new nodes.post.PostNode(_route, targetNode, version, _config);

            targetNode.items.push(_node);
        },

        addLevelsToVersion = function(targetNode, version) {

            var baseRoute = targetNode.getBaseRoute();

            routes[baseRoute.name].conditions = routes[baseRoute.name].conditions || {};
            targetNode.items = targetNode.items || [];

            var levels = version.levels;
            if(!levels) return;

            levels.forEach(function(level) {
                var conditions = {
                    conditions: {
                        lib: version.repo,
                        version: version.ref,
                        level: level.name
                    }
                };

                collectConditionsForBaseRoute(baseRoute, conditions);

                //create node
                var _route = {
                        route: _.extend({}, { name: baseRoute.name }, conditions),
                        url: susanin.Route(routes[baseRoute.name]).build(conditions.conditions)
                    },
                    _node = new nodes.level.LevelNode(_route, targetNode, level);

                targetNode.items.push(_node);

                addBlocksToLevel(_node, version, level);
            });
        },

        addBlocksToLevel = function(targetNode, version, level) {
            logger.verbose('add blocks to level');

            var baseRoute = targetNode.getBaseRoute();

            routes[baseRoute.name].conditions = routes[baseRoute.name].conditions || {};
            targetNode.items = targetNode.items || [];

            var blocks = level.blocks;
            if(!blocks) return;

            blocks.forEach(function(block) {
                var conditions = {
                    conditions: {
                        lib: version.repo,
                        version: version.ref,
                        level: level.name,
                        block: block.name
                    }
                };

                collectConditionsForBaseRoute(baseRoute, conditions);

                //create node
                var _route = {
                        route: _.extend({}, { name: baseRoute.name }, conditions),
                        url: susanin.Route(routes[baseRoute.name]).build(conditions.conditions)
                    },
                    _node = new nodes.block.BlockNode(_route, targetNode, block);

                    _node.setSource({
                        prefix: u.format({
                            'public': 'https://raw.github.com/%s/%s/%s/%s/%s/%s/%s',
                            'private': 'https://github.yandex-team.ru/%s/%s/raw/%s/%s/%s/%s/%s'
                        }[librariesRepository.type], librariesRepository.user, librariesRepository.repo,
                            librariesRepository.ref, version.repo, version.ref, level.name, block.name),
                        data: block.data,
                        jsdoc: block.jsdoc
                    });

                targetNode.items.push(_node);
            });
        };

    nodesWithLib.forEach(function(node) {
        addVersionsToLibrary(node);
    });
};

/**
 * Finds node by attribute and its value
 * @param field - {Stirng} name of attribute
 * @param value - {String} value of attribute
 * @returns {Object} node
 */
var findNodeByCriteria = function(field, value) {

    var result = null,
        traverseTreeNodes = function(node) {
            if(node[field] && node[field] === value) {
                result = node;
            }

            if(!result && node.items) {
                node.items.forEach(function(item) {
                    traverseTreeNodes(item);
                });
            }
        };

    sitemap.forEach(function(node) {
        if(result) {
            return;
        }
        traverseTreeNodes(node);
    });

    return result;
};