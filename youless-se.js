module.exports = function(RED) {
    "use strict";
    const axios = require('axios');
    const dns = require('dns');
    const { networkInterfaces } = require('os');
    const { promisify } = require('util');
    const lookup = promisify(dns.lookup);
    const reverse = promisify(dns.reverse);

    // Get local network interfaces to determine network ranges to scan
    function getLocalNetworks() {
        const nets = networkInterfaces();
        const networks = [];
        
        for (const name of Object.keys(nets)) {
            for (const net of nets[name]) {
                // Skip over non-IPv4 and internal (loopback) addresses
                if (net.family === 'IPv4' && !net.internal) {
                    // Extract network part of the IP
                    const parts = net.address.split('.');
                    if (parts.length === 4) {
                        networks.push({
                            base: `${parts[0]}.${parts[1]}.${parts[2]}`,
                            netmask: net.netmask
                        });
                    }
                }
            }
        }
        
        return networks;
    }

    // Function to ping a potential YouLess device
    async function pingYouLess(ip) {
        try {
            // First try to get the device model information from /d endpoint
            // This works for both LS110 and LS120
            let model = "Unknown";
            let mac = "";
            let isYouLess = false;
            
            try {
                const modelResponse = await axios.get(`http://${ip}/d`, {
                    timeout: 2000,
                    validateStatus: function (status) {
                        return status < 500; // Accept all responses < 500
                    }
                });
                
                if (modelResponse.status === 200 && modelResponse.data) {
                    // Parse JSON if it's a string
                    let deviceInfo = modelResponse.data;
                    if (typeof deviceInfo === 'string') {
                        try {
                            deviceInfo = JSON.parse(deviceInfo);
                        } catch (e) {
                            // If it fails to parse, just continue
                        }
                    }
                    
                    // Extract model and MAC if available
                    if (deviceInfo.model) {
                        model = deviceInfo.model;
                        isYouLess = true; // If we got a model, it's likely a YouLess device
                    }
                    if (deviceInfo.mac) {
                        mac = deviceInfo.mac;
                    }
                }
            } catch (modelError) {
                // Couldn't get model info, continue with other checks
            }
            
            // If we haven't confirmed it's a YouLess, try an endpoint check based on potential model
            if (!isYouLess) {
                try {
                    // For LS110, check the /a?f=j endpoint
                    const ls110Response = await axios.get(`http://${ip}/a?f=j`, {
                        timeout: 2000,
                        validateStatus: function (status) {
                            return status < 500;
                        }
                    });
                    
                    if (ls110Response.status === 200 && ls110Response.data) {
                        // Check for LS110-specific data pattern
                        const data = ls110Response.data;
                        if (data.cnt !== undefined && data.pwr !== undefined) {
                            isYouLess = true;
                            model = "LS110"; // If /a?f=j works, it's likely an LS110
                        }
                    }
                } catch (ls110Error) {
                    // Not an LS110 or not responding to that endpoint
                }
                
                // If still not confirmed, try LS120 endpoint
                if (!isYouLess) {
                    try {
                        const ls120Response = await axios.get(`http://${ip}/e?f=j`, {
                            timeout: 2000,
                            validateStatus: function (status) {
                                return status < 500;
                            }
                        });
                        
                        if (ls120Response.status === 200 && ls120Response.data) {
                            // Check for LS120-specific data pattern
                            if (Array.isArray(ls120Response.data) && 
                                ls120Response.data.length > 0 && 
                                (ls120Response.data[0].pwr !== undefined || ls120Response.data[0].net !== undefined)) {
                                isYouLess = true;
                                model = "LS120"; // If /e?f=j works, it's likely an LS120
                            }
                        }
                    } catch (ls120Error) {
                        // Not an LS120 or not responding to that endpoint
                    }
                }
            }
            
            // If we've confirmed it's a YouLess device, return the details
            if (isYouLess) {
                let name = null;
                // Try to get hostname
                try {
                    const hostnames = await reverse(ip);
                    if (hostnames && hostnames.length > 0) {
                        name = hostnames[0];
                    }
                } catch (e) {
                    // Ignore reverse lookup errors
                }
                
                return {
                    ip: ip,
                    name: name,
                    model: model,
                    mac: mac
                };
            }
            
            return null;
        } catch (error) {
            // Ignore errors, device is not a YouLess or not responsive
            return null;
        }
    }

    // Main YouLess discovery function
    async function discoverYouLess() {
        const networks = getLocalNetworks();
        const devices = [];
        const scanPromises = [];
        
        // Scan each network
        for (const network of networks) {
            // Scan range of IPs (1-254 for typical home networks)
            for (let i = 1; i <= 254; i++) {
                const ip = `${network.base}.${i}`;
                scanPromises.push(
                    pingYouLess(ip).then(result => {
                        if (result) {
                            devices.push(result);
                        }
                    })
                );
            }
        }
        
        // Wait for all scans to complete
        await Promise.all(scanPromises);
        return devices;
    }

    // Helper function to round numbers to specified decimal places
    function roundToDecimalPlaces(value, decimalPlaces) {
        if (decimalPlaces < 0 || !Number.isFinite(value) || isNaN(value)) {
            return value; // Return unchanged if invalid
        }
        
        const factor = Math.pow(10, decimalPlaces);
        return Math.round(value * factor) / factor;
    }

    // Helper function to process objects recursively and round all number values
    function processObjectValues(obj, decimalPlaces) {
        if (obj === null || typeof obj !== 'object') {
            return obj;
        }
        
        // For arrays, process each item
        if (Array.isArray(obj)) {
            return obj.map(item => processObjectValues(item, decimalPlaces));
        }
        
        // For objects, process each property
        const result = {};
        for (const key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) {
                const value = obj[key];
                
                if (typeof value === 'number') {
                    result[key] = roundToDecimalPlaces(value, decimalPlaces);
                } else if (typeof value === 'object' && value !== null) {
                    result[key] = processObjectValues(value, decimalPlaces);
                } else {
                    result[key] = value;
                }
            }
        }
        
        return result;
    }

    // Helper function to parse numeric string that might contain a comma instead of a period
    function parseNumericString(str) {
        if (typeof str !== 'string') return str;
        // Replace comma with period and trim whitespace
        const cleaned = str.trim().replace(',', '.');
        const num = parseFloat(cleaned);
        return isNaN(num) ? str : num;
    }

    function YoulessNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        
        // Store configuration
        this.host = config.host;
        this.interval = config.interval || 10;
        this.name = config.name || "YouLess SE";
        this.model = config.model || "LS110";
        this.password = config.password || "";
        this.startAutomatically = config.startAutomatically !== false; // Ensure proper boolean conversion
        this.showNegativeCurrent = config.showNegativeCurrent || false;
        this.customTopic = config.customTopic || "";
        this.decimalPlaces = parseInt(config.decimalPlaces);
        
        // Validate decimal places
        if (isNaN(this.decimalPlaces) || this.decimalPlaces < 0) {
            this.decimalPlaces = -1; // Disabled (don't round)
        }
        
        // Status management
        let intervalId = null;
        let errorCount = 0;
        const MAX_ERRORS = 10;
        
        // Set initial status
        node.status({fill: "grey", shape: "dot", text: "not running"});

        // Create request configuration
        function createRequestConfig() {
            let requestConfig = {
                timeout: 10000, // 10 seconds timeout
                headers: {
                    'Accept': 'application/json'
                }
            };
            
            if (node.password) {
                const auth = Buffer.from(`:${node.password}`).toString('base64');
                requestConfig.headers['Authorization'] = `Basic ${auth}`;
            }
            
            return requestConfig;
        }

        // Function to fetch data from LS110 model
        async function fetchLS110Data() {
            const baseUrl = `http://${node.host}`;
            let meterData = {
                timestamp: new Date().toISOString(),
                model: "LS110"
            };
            
            // Fetch main energy data from the LS110 JSON endpoint
            const response = await axios.get(`${baseUrl}/a?f=j`, createRequestConfig());
            
            node.log(`Raw LS110 data: ${JSON.stringify(response.data)}`);
            
            // Process LS110 data
            const data = response.data;
            
            // Extract electricity values
            meterData.power = data.pwr;
            meterData.isGenerating = data.pwr < 0;
            meterData.powerAbsolute = Math.abs(data.pwr);
            
            // Counter value (parse string with potential comma)
            meterData.counter = parseNumericString(data.cnt);
            
            // Signal level
            if (data.lvl !== undefined) {
                meterData.signalLevel = data.lvl;
            }
            
            // Additional fields if they exist
            if (data.dev) meterData.device = data.dev;
            if (data.det) meterData.details = data.det;
            if (data.con) meterData.connection = data.con;
            if (data.sts) meterData.status = data.sts;
            if (data.raw) meterData.rawValue = data.raw;
            
            return meterData;
        }

        // Function to fetch data from LS120 model
        async function fetchLS120Data() {
            const baseUrl = `http://${node.host}`;
            let meterData = {
                timestamp: new Date().toISOString(),
                model: "LS120"
            };
            
            // Fetch main energy data from the LS120 JSON endpoint
            const energyResponse = await axios.get(`${baseUrl}/e?f=j`, createRequestConfig());
            
            node.log(`Raw LS120 energy data: ${JSON.stringify(energyResponse.data)}`);
            
            // Process LS120 energy data
            if (energyResponse.data && Array.isArray(energyResponse.data) && energyResponse.data.length > 0) {
                const data = energyResponse.data[0];
                
                // Extract main electricity values
                meterData.power = data.pwr;
                meterData.isGenerating = data.pwr < 0;
                meterData.powerAbsolute = Math.abs(data.pwr);
                
                // Total meter values
                meterData.net = data.net;  // Net meter reading (can be negative if generating more than consuming)
                
                // P1/P2 are delivery (consumption) meters, N1/N2 are return (generation) meters
                meterData.delivered = {
                    total: (data.p1 || 0) + (data.p2 || 0),
                    tariff1: data.p1 || 0,
                    tariff2: data.p2 || 0
                };
                
                meterData.returned = {
                    total: (data.n1 || 0) + (data.n2 || 0),
                    tariff1: data.n1 || 0,
                    tariff2: data.n2 || 0
                };
                
                // S0 pulse counter
                if (data.cs0 !== undefined) {
                    meterData.s0 = {
                        counter: data.cs0,
                        power: data.ps0 || 0,
                        timestamp: data.ts0 ? new Date(data.ts0 * 1000).toISOString() : null
                    };
                }
                
                // Gas meter
                if (data.gas !== undefined) {
                    meterData.gas = {
                        counter: data.gas,
                        timestamp: data.gts ? new Date(data.gts * 1000).toISOString() : null
                    };
                }
                
                // Water meter
                if (data.wtr !== undefined) {
                    meterData.water = {
                        counter: data.wtr,
                        timestamp: data.wts ? new Date(data.wts * 1000).toISOString() : null
                    };
                }
                
                // Try to get phase information
                try {
                    const phaseResponse = await axios.get(`${baseUrl}/f?f=j`, createRequestConfig());
                    
                    node.log(`Raw phase data: ${JSON.stringify(phaseResponse.data)}`);
                    
                    if (phaseResponse.data) {
                        const phaseData = phaseResponse.data;
                        
                        // Calculate phase values, potentially making currents negative
                        const processPhaseValue = (current, voltage, power) => {
                            let processedCurrent = current || 0;
                            // If showNegativeCurrent is enabled and power is negative, make current negative too
                            if (node.showNegativeCurrent && power < 0 && processedCurrent > 0) {
                                processedCurrent = -processedCurrent;
                            }
                            return {
                                current: processedCurrent,
                                voltage: voltage || 0,
                                power: power || 0
                            };
                        };
                        
                        meterData.phases = {
                            L1: processPhaseValue(phaseData.i1, phaseData.v1, phaseData.l1),
                            L2: processPhaseValue(phaseData.i2, phaseData.v2, phaseData.l2),
                            L3: processPhaseValue(phaseData.i3, phaseData.v3, phaseData.l3)
                        };
                        
                        // Additional values
                        if (phaseData.tr !== undefined) meterData.tariff = phaseData.tr;
                        if (phaseData.pa !== undefined) meterData.activePower = phaseData.pa;
                        if (phaseData.pp !== undefined) meterData.peakPower = phaseData.pp;
                        if (phaseData.pts !== undefined) meterData.peakTimestamp = new Date(phaseData.pts * 1000).toISOString();
                    }
                } catch (phaseError) {
                    node.warn(`Error getting phase data: ${phaseError.message}`);
                }
            }
            
            return meterData;
        }

        // Detect the actual model if not sure
        async function detectModel() {
            try {
                // Try to get model information from /d endpoint
                const modelResponse = await axios.get(`http://${node.host}/d`, createRequestConfig());
                
                if (modelResponse.data) {
                    // Parse JSON if it's a string
                    let deviceInfo = modelResponse.data;
                    if (typeof deviceInfo === 'string') {
                        try {
                            deviceInfo = JSON.parse(deviceInfo);
                        } catch (e) {
                            // If it fails to parse, just use the configured model
                            return node.model;
                        }
                    }
                    
                    // Return detected model if available
                    if (deviceInfo.model) {
                        return deviceInfo.model;
                    }
                }
            } catch (error) {
                // If we can't detect the model, fall back to the configured model
                node.warn(`Couldn't detect model: ${error.message}, using configured model: ${node.model}`);
            }
            
            return node.model;
        }

        // Function to validate required configuration
        function validateConfig() {
            // Check for required host
            if (!node.host || node.host.trim() === "") {
                node.error("Host/IP address is required but not configured");
                node.status({fill: "red", shape: "dot", text: "missing host configuration"});
                return false;
            }
            
            // Check for required model
            if (!node.model || !["LS110", "LS120"].includes(node.model)) {
                node.error("Valid model (LS110/LS120) is required but not configured");
                node.status({fill: "red", shape: "dot", text: "missing model configuration"});
                return false;
            }
            
            // Check interval is valid
            if (isNaN(node.interval) || node.interval < 1) {
                node.warn("Invalid interval, using default of 10 seconds");
                node.interval = 10;
            }
            
            return true;
        }

        // Fetch data from YouLess meter
        async function fetchData() {
            try {
                // Validate configuration first
                if (!validateConfig()) {
                    stopPolling();
                    return;
                }
                
                // First detect or confirm the model
                const detectedModel = await detectModel();
                let meterData;
                
                // Fetch data based on the detected model
                if (detectedModel === "LS110") {
                    meterData = await fetchLS110Data();
                } else if (detectedModel === "LS120") {
                    meterData = await fetchLS120Data();
                } else {
                    // If we can't determine the model, try LS120 first, then fall back to LS110
                    try {
                        meterData = await fetchLS120Data();
                    } catch (ls120Error) {
                        meterData = await fetchLS110Data();
                    }
                }
                
                // Apply decimal places formatting if enabled
                if (node.decimalPlaces >= 0) {
                    meterData = processObjectValues(meterData, node.decimalPlaces);
                }
                
                // Reset error count on success
                errorCount = 0;
                
                // Update node status
                const powerDisplay = meterData.isGenerating ? 
                    `-${meterData.powerAbsolute}` : 
                    `${meterData.powerAbsolute}`;
                
                node.status({
                    fill: meterData.isGenerating ? "green" : "yellow",
                    shape: "dot", 
                    text: `${powerDisplay} W`
                });
                
                // Determine message topic
                let messageTopic = "youless";
                if (node.customTopic) {
                    messageTopic = node.customTopic;
                }
                
                // Send message with the data
                node.send({
                    topic: messageTopic,
                    payload: meterData
                });
            } catch (error) {
                errorCount++;
                node.status({fill: "red", shape: "ring", text: `error (${errorCount}/${MAX_ERRORS})`});
                node.warn(`Error fetching YouLess data: ${error.message}`);
                
                if (errorCount >= MAX_ERRORS) {
                    clearInterval(intervalId);
                    intervalId = null;
                    node.status({fill: "red", shape: "dot", text: "stopped after errors"});
                    node.error("Stopped polling due to multiple consecutive errors");
                }
            }
        }

        // Start polling
        function startPolling() {
            // If already polling, don't start again
            if (intervalId !== null) return;
            
            // Validate configuration before starting
            if (!validateConfig()) {
                return;
            }
            
            errorCount = 0;
            node.status({fill: "green", shape: "dot", text: "polling..."});
            
            // Immediate first call
            fetchData();
            
            // Set up the interval
            intervalId = setInterval(fetchData, node.interval * 1000);
            node.log(`YouLess SE node started polling host ${node.host} at interval ${node.interval}s`);
        }

        // Stop polling
        function stopPolling() {
            if (intervalId !== null) {
                clearInterval(intervalId);
                intervalId = null;
                node.status({fill: "grey", shape: "dot", text: "not running"});
                node.log("YouLess SE node stopped polling");
            }
        }

        // Handle input messages to control the node
        node.on('input', function(msg) {
            if (msg.payload === "stop") {
                stopPolling();
            } else if (msg.payload === "start") {
                startPolling();
            } else if (msg.payload === "restart") {
                stopPolling();
                startPolling();
            } else {
                // For single fetch, validate configuration first
                if (validateConfig()) {
                    fetchData();
                }
            }
        });

        // Start polling when the node is deployed (if configured)
        if (this.startAutomatically) {
            // Use a small delay to ensure all initialization is complete
            setTimeout(() => {
                startPolling();
            }, 1000);
        }

        // Clean up on node removal or redeploy
        node.on('close', function() {
            stopPolling();
        });
    }

    RED.nodes.registerType("youless-se", YoulessNode);
    
    // Node configuration in the admin UI
    RED.httpAdmin.get("/youless-se/models", function(req, res) {
        const models = [
            { value: "LS110", label: "LS110 (Basic model)" },
            { value: "LS120", label: "LS120 (with S0 pulse counter)" }
        ];
        res.json(models);
    });
    
    // Add auto-discover endpoint
    RED.httpAdmin.get("/youless-se/discover", async function(req, res) {
        try {
            const devices = await discoverYouLess();
            res.json({ devices: devices });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
};
