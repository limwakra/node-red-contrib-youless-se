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
            // First check if it responds to the energy endpoint
            const energyResponse = await axios.get(`http://${ip}/e?f=j`, {
                timeout: 2000,
                validateStatus: function (status) {
                    return status < 500; // Accept all responses < 500 to capture 404 responses too
                }
            });
            
            // Check if response looks like a YouLess
            if (energyResponse.status === 200 && energyResponse.data) {
                // Look for YouLess-specific data patterns
                if (Array.isArray(energyResponse.data) && 
                    energyResponse.data.length > 0 && 
                    (energyResponse.data[0].pwr !== undefined || energyResponse.data[0].net !== undefined)) {
                    
                    // Now get the device model from the /d endpoint
                    let model = "Unknown";
                    let mac = "";
                    
                    try {
                        const modelResponse = await axios.get(`http://${ip}/d`, {
                            timeout: 2000
                        });
                        
                        if (modelResponse.status === 200 && modelResponse.data) {
                            // Parse JSON if it's a string (sometimes the response might be a string)
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
                            }
                            if (deviceInfo.mac) {
                                mac = deviceInfo.mac;
                            }
                        }
                    } catch (modelError) {
                        // If model info fails, just continue with unknown model
                    }
                    
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

        // Fetch data from YouLess meter
        async function fetchData() {
            try {
                const baseUrl = `http://${node.host}`;
                let meterData = {
                    timestamp: new Date().toISOString()
                };
                
                // Fetch main energy data from the correct JSON endpoint
                const energyResponse = await axios.get(`${baseUrl}/e?f=j`, createRequestConfig());
                
                node.log(`Raw energy data: ${JSON.stringify(energyResponse.data)}`);
                
                // Process main energy data
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
                    
                    // Send message with the data
                    node.send({
                        topic: "youless",
                        payload: meterData
                    });
                } else {
                    throw new Error("Invalid or empty data format received");
                }
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
            if (intervalId !== null) return;
            
            errorCount = 0;
            node.status({fill: "green", shape: "dot", text: "polling..."});
            
            // Immediate first call
            fetchData();
            
            // Set up the interval
            intervalId = setInterval(fetchData, node.interval * 1000);
        }

        // Stop polling
        function stopPolling() {
            if (intervalId !== null) {
                clearInterval(intervalId);
                intervalId = null;
                node.status({fill: "grey", shape: "dot", text: "not running"});
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
                // Any other message triggers a single fetch
                fetchData();
            }
        });

        // Start polling when the node is deployed (if configured)
        if (this.startAutomatically) {
            // Use a small delay to ensure all initialization is complete
            setTimeout(() => {
                startPolling();
                node.log(`YouLess SE node auto-started with host ${this.host}`);
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
