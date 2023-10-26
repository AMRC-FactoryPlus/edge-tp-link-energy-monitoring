// Modules
const mqtt = require("mqtt");
const fs = require("fs-extra");
const { Client } = require("tplink-smarthome-api");

// Global Variables
let appOnline = false;
const plugReconnectDelay = 5000
const plugTimeout = 5000

// Config
const config = fs.readJsonSync("./config/config.json");
const baseTopic = config.mqtt.baseTopic;
const plugNames = config.deviceAddresses;
const pollIntervalInMs = config.pollIntervalInMs;

const mqttOptions = {
  username: config.mqtt.username,
  password: config.mqtt.password,
  port: config.mqtt.port,
  will: {
    topic: baseTopic + "/App/Status",
    payload: '{"online": "false"}',
    retain: true,
  },
  clientId: "EnergyMonitorPublisher-" + Math.random().toString(16),
  connectTimeout: 30*1000,
  reconnectPeriod: 10*1000
};

// Setup Connections
const tpLinkClient = new Client();
const mqttClient = mqtt.connect(`${config.mqtt.protocol}://${config.mqtt.host}`, mqttOptions);

// MQTT Callbacks
mqttClient.on("connect", function () {
  console.log("🔌 MQTT: Connected to broker " + config.mqtt.host);
  // Incoming app commands
  mqttClient.subscribe(baseTopic + "/App/Command/#");
  // Relay controls
  mqttClient.subscribe(baseTopic + "/+/Relay");
  mqttClient.subscribe(baseTopic + "/+/Command");

  mqttClient.publish(baseTopic + "/App/Status", '{"online": "true"}');
  appOnline = true;
});

mqttClient.on("reconnect", function () {
  mqttClient.publish(baseTopic + "/App/Status", '{"online": "true"}', {retain:false});
  appOnline = true;
  console.log("🔄 MQTT: Reconnected");
});

mqttClient.on("disconnect", function () {
  console.log("☠️ MQTT: Disconnected");
});

mqttClient.on("error", function(error) {
  console.log(error.toString());
  mqttClient.publish(baseTopic + "/App/Log", error.toString());
  mqttClient.publish(baseTopic + "/App/Status", '{"online": "false"}', {retain:true});
  appOnline = false;
  console.log(`⚠️ MQTT: Error: ${err.message}`);
  process.exit()
});

mqttClient.on("message", function (topic, message) {
  // Handle app commands
  console.log("📩 APP: Incoming message on " + topic + ": " + message.toString());

  // Handle Relay control calls
  const topicElements = topic.split("/");
  const endTopic = topicElements.pop();
  const deviceName = topicElements.pop();
  let state = undefined;

  if (topic == baseTopic + "/App/Command/Restart") {
      // Restart App
      appOnline = false;
      process.exit();
  } else if (endTopic == "Relay" || endTopic == "Command") {
    // Switch Relay State

    // Parse message
    if (endTopic == "Command") {
      try {
      state = JSON.parse(message).relayState
      } catch (error) {
        console.log("⚠️ ERROR: Cannot parse Command message.");
      }
    } else {
      (message.toString() === "true" ) ? state = true: null;
      (message.toString() === "false" ) ? state = false: null;
    }

    if (typeof state != "undefined") {
    try {
      const client = new Client();
      client.getDevice({ host: deviceName }).then((device) => {
        console.log('🔎 Found device:', device.deviceType, device.alias);
        if (device.relayState != state) {
            console.log(`🔀 PLUG: Turning plug ${deviceName} to ${state}`);
          // Sorry, does not like it otherwise
            (state == true) ? device.setPowerState(true) : device.setPowerState(false);
            mqttClient.publish(`${baseTopic}/${deviceName}/Command`, JSON.stringify({ relayState: state }));
        } else {
          console.log("👌 PLUG: Already set to '" + state + "'");
        }
      });
    } catch (error) {
      console.log(error);
      mqttClient.publish(baseTopic + "/App/Log", error.toString());
    }
    } else {
      mqttClient.publish(baseTopic + "/App/Log", "PLUG: Cannot parse command '" + state + "' for " + deviceName + " . Incoming Message: " + message);
    }
  }
});

// Custom delay
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runTpLinkClient(deviceName) {
  let hasFailed = false;
  let failedOnce = false;
  do {
    try {
      console.log(`⏳ PLUG: Connecting to device ${deviceName}`);
      const device = await tpLinkClient.getDevice(
        { host: `${deviceName}` },
        { timeout: plugTimeout }
      );
      console.log(`✅ PLUG: Device ${deviceName} connected`);

      // Update meta
      const deviceSysInfo = await device.getSysInfo();
      const relayState = await device.getPowerState();
      mqttClient.publish(`${baseTopic}/${deviceName}/Status`, JSON.stringify({ online: true }));
      mqttClient.publish(`${baseTopic}/${deviceName}/DeviceInfo`, JSON.stringify(deviceSysInfo));
      mqttClient.publish(`${baseTopic}/${deviceName}/Command`, JSON.stringify({ relayState: relayState}, {retain:false}));

      while (true) {
        try {
          const devicePowerState = await device.getPowerState();
          const inUse = await device.getInUse();
          var info = device.emeter.realtime;
          info.inUse = inUse;
          info.plugRelayActive = devicePowerState;

          // Pub data
          mqttClient.publish(`${baseTopic}/${deviceName}/Metrics`, JSON.stringify(info));
          mqttClient.publish(`${baseTopic}/${deviceName}/Status`, JSON.stringify({ online: true }));

          await delay(pollIntervalInMs);
        } catch (e) {
          hasFailed = true;
          mqttClient.publish(`${baseTopic}/${deviceName}/Status`, JSON.stringify({ online: false }), { retain: true });
          await delay(plugReconnectDelay);
          break;
        }
      }
    } catch ({ name, code, errno, message, hostname}) {
      if(errno == -3008){
        console.log(`👎 PLUG: Cannot reach to host: ${deviceName}`);
      } else {
        console.log(message);
      }
      mqttClient.publish(`${baseTopic}/${deviceName}/Status`, JSON.stringify({ online: false }), { retain: true });
      hasFailed = true;
      await delay(plugReconnectDelay);
    }
  } while (hasFailed);
}

const run = async () => {
  const asyncCalls = [];

  for (var i = 0; i < plugNames.length; i++) {
    // Create instance for each plug connection
    asyncCalls.push(runTpLinkClient(plugNames[i]));
  }

  try {
    Promise.all(asyncCalls);
  } catch (err) {
    console.error("⚠️ Error Occur: ", err.message);
  }
};

// Main Start
run();

// App status updater
const appStatusUpdater = setInterval(() => {
  try {
    if (appOnline == true) {
      mqttClient.publish(baseTopic + "/App/Status", JSON.stringify({ online: true }));
    }
  } catch (error) {
    //
  }
}, 10000);
