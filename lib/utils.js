'use strict';

const globalStore = require('./store');
const herdsman = require('zigbee-herdsman');

function isLegacyEnabled(options) {
    return !options.hasOwnProperty('legacy') || options.legacy;
}

function precisionRound(number, precision) {
    if (typeof precision === 'number') {
        const factor = Math.pow(10, precision);
        return Math.round(number * factor) / factor;
    } else if (typeof precision === 'object') {
        const thresholds = Object.keys(precision).map(Number).sort((a, b) => b - a);
        for (const t of thresholds) {
            if (! isNaN(t) && number >= t) {
                return precisionRound(number, precision[t]);
            }
        }
    }
    return number;
}

function toLocalISOString(dDate) {
    const tzOffset = -dDate.getTimezoneOffset();
    const plusOrMinus = tzOffset >= 0 ? '+' : '-';
    const pad = function(num) {
        const norm = Math.floor(Math.abs(num));
        return (norm < 10 ? '0' : '') + norm;
    };

    return dDate.getFullYear() +
        '-' + pad(dDate.getMonth() + 1) +
        '-' + pad(dDate.getDate()) +
        'T' + pad(dDate.getHours()) +
        ':' + pad(dDate.getMinutes()) +
        ':' + pad(dDate.getSeconds()) +
        plusOrMinus + pad(tzOffset / 60) +
        ':' + pad(tzOffset % 60);
}

function numberWithinRange(number, min, max) {
    if (number > max) {
        return max;
    } else if (number < min) {
        return min;
    } else {
        return number;
    }
}

/**
 * Maps number from one range to another. In other words it performs a linear interpolation.
 * Note that this function can interpolate values outside source range (linear extrapolation).
 * @param {number} value value to map
 * @param {number} fromLow source range lower value
 * @param {number} fromHigh source range upper value
 * @param {number} toLow target range lower value
 * @param {number} toHigh target range upper value
 * @param {number} [precision=0] number of decimal places to which result should be rounded
 * @return {number} value mapped to new range
 */
function mapNumberRange(value, fromLow, fromHigh, toLow, toHigh, precision=0) {
    const mappedValue = toLow + (value - fromLow) * (toHigh - toLow) / (fromHigh - fromLow);
    return precisionRound(mappedValue, precision);
}

const transactionStore = {};
function hasAlreadyProcessedMessage(msg, model, ID=null, key=null) {
    if (model.meta && model.meta.publishDuplicateTransaction) return false;
    const currentID = ID !== null ? ID : msg.meta.zclTransactionSequenceNumber;
    key = key || msg.device.ieeeAddr;
    if (transactionStore[key] === currentID) return true;
    transactionStore[key] = currentID;
    return false;
}

const calibrateAndPrecisionRoundOptionsDefaultPrecision = {
    temperature: 2, humidity: 2, pressure: 1, pm25: 0, power: 2, current: 2, current_phase_b: 2, current_phase_c: 2,
    voltage: 2, voltage_phase_b: 2, voltage_phase_c: 2, power_phase_b: 2, power_phase_c: 2, energy: 2,
};
function calibrateAndPrecisionRoundOptionsIsPercentual(type) {
    return type.startsWith('current') || type.startsWith('energy') || type.startsWith('voltage') || type.startsWith('power') ||
        type.startsWith('illuminance');
}
function calibrateAndPrecisionRoundOptions(number, options, type) {
    // Calibrate
    const calibrateKey = `${type}_calibration`;
    let calibrationOffset = options && options.hasOwnProperty(calibrateKey) ? options[calibrateKey] : 0;
    if (calibrateAndPrecisionRoundOptionsIsPercentual(type)) {
        // linear calibration because measured value is zero based
        // +/- percent
        calibrationOffset = Math.round(number * calibrationOffset / 100);
    }
    number = number + calibrationOffset;

    // Precision round
    const precisionKey = `${type}_precision`;
    const defaultValue = calibrateAndPrecisionRoundOptionsDefaultPrecision[type] || 0;
    const precision = options && options.hasOwnProperty(precisionKey) ? options[precisionKey] : defaultValue;
    return precisionRound(number, precision);
}

function toPercentage(value, min, max, log=false) {
    if (value > max) {
        value = max;
    } else if (value < min) {
        value = min;
    }

    const normalised = (value - min) / (max - min);
    return Math.round(normalised * 100);
}

function addActionGroup(payload, msg, definition) {
    const disableActionGroup = definition.meta && definition.meta.disableActionGroup;
    if (!disableActionGroup && msg.groupID) {
        payload.action_group = msg.groupID;
    }
}

function postfixWithEndpointName(value, msg, definition, meta) {
    // Prevent breaking change https://github.com/Koenkk/zigbee2mqtt/issues/13451
    if (!meta) {
        meta.logger.warn(`No meta passed to postfixWithEndpointName, update your external converter!`);
        meta = {device: null};
    }

    if (definition.meta && definition.meta.multiEndpoint &&
            (!definition.meta.multiEndpointSkip || !definition.meta.multiEndpointSkip.includes(value))) {
        const endpointName = definition.hasOwnProperty('endpoint') ?
            getKey(definition.endpoint(meta.device), msg.endpoint.ID) : msg.endpoint.ID;

        // NOTE: endpointName can be undefined if we have a definition.endpoint and the endpoint is
        //       not listed.
        if (endpointName) return `${value}_${endpointName}`;
    }
    return value;
}

function enforceEndpoint(entity, key, meta) {
    const multiEndpointEnforce = getMetaValue(entity, meta.mapped, 'multiEndpointEnforce', 'allEqual', []);
    if (multiEndpointEnforce && multiEndpointEnforce.hasOwnProperty(key)) {
        const endpoint = entity.getDevice().getEndpoint(multiEndpointEnforce[key]);
        if (endpoint) return endpoint;
    }
    return entity;
}

function getKey(object, value, fallback, convertTo) {
    for (const key in object) {
        if (object[key]===value) {
            return convertTo ? convertTo(key) : key;
        }
    }

    return fallback;
}

function batteryVoltageToPercentage(voltage, option) {
    let percentage = null;
    if (option === '3V_2100') {
        if (voltage < 2100) {
            percentage = 0;
        } else if (voltage < 2440) {
            percentage = 6 - ((2440 - voltage) * 6) / 340;
        } else if (voltage < 2740) {
            percentage = 18 - ((2740 - voltage) * 12) / 300;
        } else if (voltage < 2900) {
            percentage = 42 - ((2900 - voltage) * 24) / 160;
        } else if (voltage < 3000) {
            percentage = 100 - ((3000 - voltage) * 58) / 100;
        } else if (voltage >= 3000) {
            percentage = 100;
        }
        percentage = Math.round(percentage);
    } else if (option === '3V_2500') {
        percentage = toPercentage(voltage, 2500, 3000);
    } else if (option === '3V_2500_3200') {
        percentage = toPercentage(voltage, 2500, 3200);
    } else if (option === '3V_1500_2800') {
        percentage = 235 - 370000 / (voltage + 1);
        if (percentage > 100) {
            percentage = 100;
        } else if (percentage < 0) {
            percentage = 0;
        }
        percentage = Math.round(percentage);
    } else if (option === '3V_2850_3000') {
        percentage = toPercentage(voltage, 2850, 3000);
    } else if (option === '4LR6AA1_5v') {
        percentage = toPercentage(voltage, 3000, 4200);
    } else if (option === '3V_add 1V') {
        voltage = voltage + 1000;
        percentage = toPercentage(voltage, 3200, 4200);
    } else if (option === 'Add_1V_42V_CSM300z2v2') {
        voltage = voltage + 1000;
        percentage = toPercentage(voltage, 2900, 4100);
    // Generic converter that expects an option object with min and max values
    // I.E. meta: {battery: {voltageToPercentage: {min: 1900, max: 3000}}}
    } else if (typeof option === 'object') {
        percentage = toPercentage(voltage, option.min, option.max);
    } else {
        throw new Error(`Not batteryVoltageToPercentage type supported: ${option}`);
    }

    return percentage;
}

// groupStrategy: allEqual: return only if all members in the groups have the same meta property value.
//                first: return the first property
function getMetaValue(entity, definition, key, groupStrategy='first', defaultValue=undefined) {
    if (entity.constructor.name === 'Group' && entity.members.length > 0) {
        const values = [];
        for (let i = 0; i < entity.members.length; i++) {
            const memberMetaMeta = getMetaValues(definition[i], entity.members[i]);
            if (memberMetaMeta && memberMetaMeta.hasOwnProperty(key)) {
                if (groupStrategy === 'first') {
                    return memberMetaMeta[key];
                }

                values.push(memberMetaMeta[key]);
            } else {
                values.push(defaultValue);
            }
        }

        if (groupStrategy === 'allEqual' && (new Set(values)).size === 1) {
            return values[0];
        }
    } else {
        const definitionMeta = getMetaValues(definition, entity);
        if (definitionMeta && definitionMeta.hasOwnProperty(key)) {
            return definitionMeta[key];
        }
    }

    return defaultValue;
}

function hasEndpoints(device, endpoints) {
    const eps = device.endpoints.map((e) => e.ID);
    for (const endpoint of endpoints) {
        if (!eps.includes(endpoint)) {
            return false;
        }
    }
    return true;
}

function isInRange(min, max, value) {
    return value >= min && value <= max;
}

function replaceInArray(arr, oldElements, newElements) {
    const clone = [...arr];
    for (let i = 0; i < oldElements.length; i++) {
        const index = clone.indexOf(oldElements[i]);

        if (index !== -1) {
            clone[index] = newElements[i];
        } else {
            throw new Error('Element not in array');
        }
    }

    return clone;
}

function filterObject(obj, keys) {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
        if (keys.includes(key)) {
            result[key] = value;
        }
    }
    return result;
}

async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function toSnakeCase(value) {
    if (typeof value === 'object') {
        for (const key of Object.keys(value)) {
            const keySnakeCase = toSnakeCase(key);
            if (key !== keySnakeCase) {
                value[keySnakeCase] = value[key];
                delete value[key];
            }
        }
        return value;
    } else {
        return value.replace(/\.?([A-Z])/g, (x, y) => '_' + y.toLowerCase()).replace(/^_/, '').replace('_i_d', '_id');
    }
}

function toCamelCase(value) {
    if (typeof value === 'object') {
        for (const key of Object.keys(value)) {
            const keyCamelCase = toCamelCase(key);
            if (key !== keyCamelCase) {
                value[keyCamelCase] = value[key];
                delete value[key];
            }
        }
        return value;
    } else {
        return value.replace(/_([a-z])/g, (x, y) => y.toUpperCase());
    }
}

function saveSceneState(entity, sceneID, groupID, state, name) {
    const attributes = ['state', 'brightness', 'color', 'color_temp', 'color_mode'];
    if (!entity.meta.hasOwnProperty('scenes')) entity.meta.scenes = {};
    const metaKey = `${sceneID}_${groupID}`;
    entity.meta.scenes[metaKey] = {name, state: filterObject(state, attributes)};
    entity.save();
}

function deleteSceneState(entity, sceneID=null, groupID=null) {
    if (entity.meta.scenes) {
        if (sceneID == null && groupID == null) {
            entity.meta.scenes = {};
        } else {
            const metaKey = `${sceneID}_${groupID}`;
            if (entity.meta.scenes.hasOwnProperty(metaKey)) {
                delete entity.meta.scenes[metaKey];
            }
        }
        entity.save();
    }
}

function getSceneState(entity, sceneID, groupID) {
    const metaKey = `${sceneID}_${groupID}`;
    if (entity.meta.hasOwnProperty('scenes') && entity.meta.scenes.hasOwnProperty(metaKey)) {
        return entity.meta.scenes[metaKey].state;
    }

    return null;
}

function getEntityOrFirstGroupMember(entity) {
    if (entity.constructor.name === 'Group') {
        return entity.members.length > 0 ? entity.members[0] : null;
    } else {
        return entity;
    }
}

function getTransition(entity, key, meta) {
    const {options, message} = meta;

    let manufacturerIDs = [];
    if (entity.constructor.name === 'Group') {
        manufacturerIDs = entity.members.map((m) => m.getDevice().manufacturerID);
    } else if (entity.constructor.name === 'Endpoint') {
        manufacturerIDs = [entity.getDevice().manufacturerID];
    }

    if (manufacturerIDs.includes(4476)) {
        /**
         * When setting both brightness and color temperature with a transition, the brightness is skipped
         * for IKEA TRADFRI bulbs.
         * To workaround this we skip the transition for the brightness as it is applied first.
         * https://github.com/Koenkk/zigbee2mqtt/issues/1810
         */
        if (key === 'brightness' && (message.hasOwnProperty('color') || message.hasOwnProperty('color_temp'))) {
            return {time: 0, specified: false};
        }
    }

    if (message.hasOwnProperty('transition')) {
        return {time: message.transition * 10, specified: true};
    } else if (options.hasOwnProperty('transition')) {
        return {time: options.transition * 10, specified: true};
    } else {
        return {time: 0, specified: false};
    }
}

function getOptions(definition, entity, options={}) {
    const allowed = ['disableDefaultResponse', 'timeout'];
    return getMetaValues(definition, entity, allowed, options);
}

function getMetaValues(definition, entity, allowed, options={}) {
    const result = {...options};
    if (definition && definition.meta) {
        for (const key of Object.keys(definition.meta)) {
            if (allowed == null || allowed.includes(key)) {
                const value = definition.meta[key];
                result[key] = typeof value === 'function' ? value(entity) : value;
            }
        }
    }

    return result;
}

function getObjectProperty(object, key, defaultValue) {
    return object && object.hasOwnProperty(key) ? object[key] : defaultValue;
}

function validateValue(value, allowed) {
    if (!allowed.includes(value)) {
        throw new Error(`'${value}' not allowed, choose between: ${allowed}`);
    }
}

function normalizeCelsiusVersionOfFahrenheit(value) {
    const fahrenheit = (value * 1.8) + 32;
    const roundedFahrenheit = (Math.round((fahrenheit * 2).toFixed(1)) / 2).toFixed(1);
    return ((roundedFahrenheit - 32)/1.8).toFixed(2);
}

function extendDevice(deviceConfigs, modelName, adjustments) {
    const baseDevice = deviceConfigs.find((device) => device.model === modelName);
    if (typeof baseDevice !== 'object') {
        throw Error(`Could not find model ${modelName} in provided device list`);
    }
    return {...baseDevice, ...adjustments};
}

function noOccupancySince(endpoint, options, publish, action) {
    if (options && options.no_occupancy_since) {
        if (action == 'start') {
            globalStore.getValue(endpoint, 'no_occupancy_since_timers', []).forEach((t) => clearTimeout(t));
            globalStore.putValue(endpoint, 'no_occupancy_since_timers', []);

            options.no_occupancy_since.forEach((since) => {
                const timer = setTimeout(() => {
                    publish({no_occupancy_since: since});
                }, since * 1000);
                globalStore.getValue(endpoint, 'no_occupancy_since_timers').push(timer);
            });
        } else if (action === 'stop') {
            globalStore.getValue(endpoint, 'no_occupancy_since_timers', []).forEach((t) => clearTimeout(t));
            globalStore.putValue(endpoint, 'no_occupancy_since_timers', []);
        }
    }
}

function attachOutputCluster(device, clusterKey) {
    const clusterId = herdsman.Zcl.Utils.getCluster(clusterKey).ID;
    const endpoint = device.getEndpoint(1);

    if (!endpoint.outputClusters.includes(clusterId)) {
        endpoint.outputClusters.push(clusterId);
        device.save();
    }
}

/**
 * @param {number} value
 * @param {number} hexLength
 * @return {string}
 */
function printNumberAsHex(value, hexLength) {
    const hexValue = value.toString(16).padStart(hexLength, '0');
    return `0x${hexValue}`;
}

/**
 * @param {number[]} numbers
 * @param {number} hexLength
 * @return {string}
 */
function printNumbersAsHexSequence(numbers, hexLength) {
    return numbers.map((v) => v.toString(16).padStart(hexLength, '0')).join(':');
}

// Note: this is valid typescript-flavored JSDoc
// eslint-disable-next-line valid-jsdoc
/**
 * @param {logger} logger
 * @param {vendor} vendor
 * @param {key} key
 * @returns {(level: string, message: string) => void}
 */
const createLogger = (logger, vendor, key) => (level, message) => {
    logger[level](`zigbee-herdsman-converters:${vendor}:${key}: ${message}`);
};

module.exports = {
    noOccupancySince,
    getOptions,
    isLegacyEnabled,
    precisionRound,
    toLocalISOString,
    numberWithinRange,
    mapNumberRange,
    hasAlreadyProcessedMessage,
    calibrateAndPrecisionRoundOptions,
    calibrateAndPrecisionRoundOptionsIsPercentual,
    calibrateAndPrecisionRoundOptionsDefaultPrecision,
    toPercentage,
    addActionGroup,
    postfixWithEndpointName,
    enforceEndpoint,
    getKey,
    getObjectProperty,
    batteryVoltageToPercentage,
    getEntityOrFirstGroupMember,
    getTransition,
    getMetaValue,
    validateValue,
    hasEndpoints,
    isInRange,
    replaceInArray,
    filterObject,
    saveSceneState,
    sleep,
    toSnakeCase,
    toCamelCase,
    normalizeCelsiusVersionOfFahrenheit,
    deleteSceneState,
    getSceneState,
    extendDevice,
    attachOutputCluster,
    printNumberAsHex,
    printNumbersAsHexSequence,
    createLogger,
};
