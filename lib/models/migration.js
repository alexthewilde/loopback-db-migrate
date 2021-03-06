'use strict';

var debug = require('debug')('loopback-db-migrate');
var path = require('path');
var fs = require('fs');
var assert = require('assert');
var utils = require('loopback-datasource-juggler/lib/utils');

module.exports = function(Migration, options) {
  options = options || {};
  Migration.log = options.log || console;
  Migration.migrationsDir = options.migrationsDir || path.join(process.cwd(), 'server', 'migrations');
  debug('Migrations directory set to: %s', Migration.migrationsDir);

  Migration.migrate = function(upOrDown, to, cb) {
    if (cb === undefined) {
      if (typeof to === 'function') {
        cb = to;
        to = '';
      }
    }
    upOrDown = upOrDown || 'up';
    to = to || '';
    cb = cb || utils.createPromiseCallback();

    assert(typeof upOrDown === 'string', 'The upOrDown argument must be a string, not ' + typeof upOrDown);
    assert(typeof to === 'string', 'The to argument must be a string, not ' + typeof to);
    assert(typeof cb === 'function', 'The cb argument must be a function, not ' + typeof cb);

    if (Migration.app.migrating) {
      Migration.log.warn('Unable to start migrations: already running');
      process.nextTick(function() {
        cb();
      });
      return cb.promise;
    }

    Migration.hrstart = process.hrtime();
    Migration.app.migrating = true;

    Migration.findScriptsToRun(upOrDown, to, function runScripts(err, scriptsToRun) {
      scriptsToRun = scriptsToRun || [];
      var migrationCallStack = [];
      var migrationCallIndex = 0;

      if (scriptsToRun.length) {
        Migration.log.info('Running migrations: \n', scriptsToRun);
      }

      scriptsToRun.forEach(function(localScriptName) {
        migrationCallStack.push(function() {

          var migrationStartTime;

          // keep calling scripts recursively until we are done, then exit
          function runNextScript(err) {
            if (err) {
              Migration.log.error('Error saving migration', localScriptName, 'to database!');
              Migration.log.error(err);
              Migration.finish(err);
              return cb(err);
            }

            var migrationEndTime = process.hrtime(migrationStartTime);
            Migration.log.info('%s finished sucessfully. Migration time was %ds %dms',
              localScriptName, migrationEndTime[0], migrationEndTime[1] / 1000000);
            migrationCallIndex++;
            if (migrationCallIndex < migrationCallStack.length) {
              migrationCallStack[migrationCallIndex]();
            } else {
              Migration.finish();
              return cb();
            }
          }

          try {
            // include the script, run the up/down function, update the migrations table, and continue
            migrationStartTime = process.hrtime();
            Migration.log.info(localScriptName, 'running.');
            require(path.join(Migration.migrationsDir, localScriptName))[upOrDown](Migration.app, function(err) {
              if (err) {
                Migration.log.error(localScriptName, 'error:');
                Migration.log.error(err.stack);
                Migration.finish(err);
                return cb(err);
              } else if (upOrDown === 'up') {
                Migration.create({
                  name: localScriptName,
                  runDtTm: new Date()
                }, runNextScript);
              } else {
                Migration.destroyAll({
                  name: localScriptName
                }, runNextScript);
              }
            });
          } catch (err) {
            Migration.log.error('Error running migration', localScriptName);
            Migration.log.error(err.stack);
            Migration.finish(err);
            cb(err);
          }
        });
      });

      // kick off recursive calls
      if (migrationCallStack.length) {
        migrationCallStack[migrationCallIndex]();
      } else {
        delete Migration.app.migrating;
        Migration.emit('complete');
        Migration.log.info('No new migrations to run.');
      }
    });

    return cb.promise;
  };

  Migration.finish = function(err) {
    if (err) {
      Migration.log.error('Migrations did not complete. An error was encountered:', err);
      Migration.emit('error', err);
    } else {
      Migration.log.info('All migrations have run without any errors.');
      Migration.emit('complete');
    }
    delete Migration.app.migrating;
    var hrend = process.hrtime(Migration.hrstart);
    Migration.log.info('Total migration time was %ds %dms', hrend[0], hrend[1] / 1000000);
  };

  Migration.findScriptsToRun = function(upOrDown, to, cb) {
    upOrDown = upOrDown || 'up';
    to = to || '';
    cb = cb || utils.createPromiseCallback();

    debug('findScriptsToRun direction:%s, to:%s', upOrDown, to ? to : 'undefined');

    // Add .js to the script name if it wasn't provided.
    if (to && to.substring(to.length - 3, to.length) !== '.js') {
      to = to + '.js';
    }

    var scriptsToRun = [];
    var order = upOrDown === 'down' ? 'name DESC' : 'name ASC';
    var filters = {
      order: order
    };

    if (to) {
      // DOWN: find only those that are greater than the 'to' point in descending order.
      if (upOrDown === 'down') {
        filters.where = {
          name: {
            gte: to
          }
        };
      }
      // UP: find only those that are less than the 'to' point in ascending order.
      else {
        filters.where = {
          name: {
            lte: to
          }
        };
      }
    }
    debug('fetching migrations from db using filter %j', filters);
    Migration.find(filters)
      .then(function(scriptsAlreadyRan) {
        scriptsAlreadyRan = scriptsAlreadyRan.map(Migration.mapScriptObjName);
        debug('scriptsAlreadyRan: %j', scriptsAlreadyRan);

        // Find rollback scripts.
        if (upOrDown === 'down') {

          // If the requested rollback script has not already run return just the requested one if it is a valid script.
          // This facilitates rollback of failed migrations.
          if (to && scriptsAlreadyRan.indexOf(to) === -1) {
            debug('requested script has not already run - returning single script as standalone rollback script');
            scriptsToRun = [to];
            return cb(null, scriptsToRun);
          }

          // Remove the last item since we don't want to roll back the requested script.
          if (scriptsAlreadyRan.length && to) {
            scriptsAlreadyRan.pop();
            debug('remove last item. scriptsAlreadyRan: %j', scriptsAlreadyRan);
          }
          scriptsToRun = scriptsAlreadyRan;

          debug('Found scripts to run: %j', scriptsToRun);
          cb(null, scriptsToRun);
        }

        // Find migration scripts.
        else {
          // get all local scripts and filter for only .js files
          var candidateScripts = fs.readdirSync(Migration.migrationsDir).filter(function(fileName) {
            return fileName.substring(fileName.length - 3, fileName.length) === '.js';
          });
          debug('Found %s candidate scripts: %j', candidateScripts.length, candidateScripts);

          // filter out those that come after the requested to value.
          if (to) {
            candidateScripts = candidateScripts.filter(function(fileName) {
              var inRange = fileName <= to;
              debug('checking wether %s is in range (%s <= %s): %s', fileName, fileName, to, inRange);
              return inRange;
            });
          }

          // filter out those that have already ran
          candidateScripts = candidateScripts.filter(function(fileName) {
            debug('checking wether %s has already run', fileName);
            var alreadyRan = scriptsAlreadyRan.indexOf(fileName) !== -1;
            debug('checking wether %s has already run: %s', fileName, alreadyRan);
            return !alreadyRan;
          });

          scriptsToRun = candidateScripts;
          debug('Found scripts to run: %j', scriptsToRun);
          cb(null, scriptsToRun);
        }
      })
      .catch(function(err) {
        Migration.log.error('Error retrieving migrations:');
        Migration.log.error(err.stack);
        cb(err);
      });

    return cb.promise;
  };

  Migration.mapScriptObjName = function(scriptObj) {
    return scriptObj.name;
  };

  return Migration;
};
