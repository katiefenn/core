var debug = require('debug')('gitevents-events');
var yamlFront = require('yaml-front-matter');
var moment = require('moment');
var parser = require('markdown-parse');
var S = require('string');
var GitHubApi = require('github');
var config = require('../config');
var milestone = require('./milestone');

var createOrUpdateEvent = function(payload, event, sender, github) {
  return new Promise(function(resolve, reject) {
    debug('createOrUpdateEvent()');

    var commit = {
      filename: config.paths.events + event.id + '.json',
      name: event.name
    };

    github.repos.getContent({
      user: config.github.org,
      repo: config.github.repos.gitevent,
      path: commit.filename
    }, function(error, eventsFile) {
      debug('GitHub:getContent()');

      var file;

      if (error && error.code === 404) {
        debug('event not found. Creating event.');
        event.about = config.about;

        file = new Buffer(JSON.stringify(event, null, 2)).toString('base64');

        github.repos.createFile({
          user: config.github.org,
          repo: config.github.repos.gitevent,
          path: commit.filename,
          content: file,
          message: 'Created event ' + event.id
        }, function(error) {
          debug('GitHub:createFile()');

          if (error) {
            return reject(new Error(error));
          }

          return resolve(event);
        });
      } else {
        var contents = new Buffer(eventsFile.content, eventsFile.encoding).toString('utf8');
        var previousEvent = JSON.parse(contents);

        //TODO: what needs updating?

        file = new Buffer(JSON.stringify(event, null, 2)).toString('base64');

        github.repos.updateFile({
          user: config.github.org,
          repo: config.github.repos.gitevent,
          path: commit.filename,
          sha: eventsFile.sha,
          content: file,
          message: 'Updated event ' + previousEvent.id
        }, function(error) {
          debug('GitHub:updateFile()');
          if (error) {
            debug(error);
            return reject(new Error(error));
          }
          return resolve(event);
        });
      }
    });
  });
};

var addTalk = function addTalk(payload, speaker, github) {
  return new Promise(function(resolve, reject) {
    debug('addTalk()');

    var eventId = payload.issue.milestone.description;

    var commit = {
      filename: config.paths.events + eventId + '.json'
    };

    github.repos.getContent({
      user: config.github.org,
      repo: config.github.repos.gitevent,
      path: commit.filename
    }, function(error, eventsFile) {
      if (error) {
        return reject('event not found.');
      }

      var talks = [];
      var contents = new Buffer(eventsFile.content, eventsFile.encoding).toString('utf8');
      var event = JSON.parse(contents);

      var talkId = moment(payload.issue.milestone.due_on, 'YYYY-MM-DDTHH:mm:ssZ').format('YYYYMMDD') + '-' + S(payload.issue.title).slugify().s;

      var performer = {
        'type': 'Person',
        'image': speaker.avatar_url,
        'name': speaker.name,
        'id': talkId,
        'sameAs': speaker.url,
        'url': config.schema.default_talk_url + talkId + '.html'
      };

      if (event.performer) {
        event.performer.map(function(p) {
          talks.push(p.id);
        });

        if (talks.indexOf(talkId) > -1) {
          // talk exists, do nothing for now
          return resolve(event);
        } else {
          event.performer.push(performer);
        }
      } else {
        event.performer = [(performer)];
      }

      var file = new Buffer(JSON.stringify(event, null, 2)).toString('base64');

      github.repos.updateFile({
        user: config.github.org,
        repo: config.github.repos.gitevent,
        path: commit.filename,
        sha: eventsFile.sha,
        content: file,
        message: 'Updated event ' + event.id
      }, function(error) {
        if (error) {
          debug(error);
          return reject(new Error(error));
        }
        return resolve(event);
      });
    });
  });
};

module.exports = function events(payload) {
  return new Promise(function(resolve, reject) {
    debug('processing event');

    var github = new GitHubApi({
      version: '3.0.0',
      debug: config.debug,
      protocol: 'https',
      timeout: 5000,
      headers: {
        'user-agent': 'GitEvents'
      }
    });

    github.authenticate({
      type: 'oauth',
      token: config.github.token
    });

    // get repo user
    github.user.getFrom({
      user: payload.sender.login
    }, function(error, sender) {
      if (error) {
        return reject(new Error(error));
      }

      debug('GitHub:getFrom():' + sender.login);

      // get author details
      github.user.getFrom({
        user: payload.issue.user.login
      }, function(error, speaker) {
        if (error) {
          return reject(new Error(error));
        }

        debug('GitHub:getFrom():' + speaker.login);

        // if this is an event from the planning repo, create a new event
        if (payload.labelMap.indexOf(config.labels.event) > -1) {
          debug('received planning event');

          parser(payload.issue.body, function(error, body) {
            if (error) {
              return reject(new Error(error));
            }

            if (body.attributes && !body.attributes.date) {
              return reject(new Error('invalid event. Date missing.'));
            }

            var eventDate = moment.utc(body.attributes.date, config.date_format).format('YYYY-MM-DD');
            var eventTime;

            if (body.attributes.time) {
              if (body.attributes.time.indexOf('.') > -1) {
                eventTime = body.attributes.time.replace(',', ':');
              } else {
                eventTime = body.attributes.time;
              }
            } else {
              eventTime = config.schema.default_start_time;
            }

            var event = config.schema.default_event;
            event.startDate = eventDate + 'T' + eventTime + ':00Z';
            event.id = moment(event.startDate).format('YYYYMMDD') + '-' + S(body.attributes.name).slugify().s;
            event.organizer = config.schema.default_organizer;
            event.github = payload.issue.url;
            event.url = config.schema.default_event_url + event.id + '.html';
            event.name = body.attributes.name;

            if (body.attributes.address) {
              var address = body.attributes.address.split(',');
              event.location.address = {
                'type': 'PostalAddress',
                'addressLocality': address[2],
                'postalCode': address[1],
                'streetAddress': address[0]
              };

              if (body.attributes.venue) {
                event.location.address.name = body.attributes.venue;
              }
            }

            milestone(payload, event, github);

            createOrUpdateEvent(payload, event, sender, github).then(function() {
              return resolve(event);
            }).catch(function(error){
              return reject(error);
            })
          });
        }

        // update event if the issue is labeled as a talk
        if (payload.labelMap.indexOf(config.labels.talk) > -1) {
          debug('adding talk to event');

          if (!payload.issue.milestone) {
            debug('no milestone found. Creating comment.');

            github.issues.createComment({
              user: config.github.org,
              repo: config.github.repos.speakers,
              number: payload.issue.number,
              body: '@' + payload.sender.login +
                ' please create an Event first, then label the issue as a talk.'
            }, function() {
              debug('GitHub:createComment()');
              reject(new Error('missing_milestone'));
            });
          } else {
            addTalk(payload, speaker, github).then(function(event) {
              return resolve(event);
            }).catch(function(error){
              return reject(error);
            });
          }
        }
      });
    });
  });
};
