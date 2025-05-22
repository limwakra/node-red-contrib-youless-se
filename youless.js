module.exports = function(RED) {
    "use strict";
    const axios = require('axios');

    function YoulessNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        
        // Store configuration
        this.host = config.host;
        this.interval = config.interval || 10;
        this.name = config.name || "YouLess";
        this.model = config.model || "LS110";
        this.password = config.password || "";
        
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
                let meterData = {};
                
                // Basic energy data (works for all models)
                const energyResponse = await axios.get(`${baseUrl}/a`, createRequestConfig());
                
                // Process energy data
                if (energyResponse.data) {
                    meterData = {
                        power: parseInt(energyResponse.data.pwr || 0),
                        counterToday: parseFloat(energyResponse.data.cnt || 0),
                        counter: parseFloat(energyResponse.data.cnt || 0),
                        timestamp: new Date().toISOString()
                    };
                    
                    // If LS120 or higher, get the additional S0 data
                    if (["LS120", "LS130", "LS140"].includes(node.model)) {
                        try {
                            const s0Response = await axios.get(`${baseUrl}/ai`, createRequestConfig());
                            if (s0Response.data && s0Response.data.dev && s0Response.data.dev.length > 0) {
                                meterData.s0 = s0Response.data.dev.map(device => ({
                                    name: device.name || `S0-${device.id}`,
                                    power: parseInt(device.pwr || 0),
                                    counter: parseFloat(device.cnt || 0)
                                }));
                            }
                        } catch (s0Error) {
                            node.warn(`Error getting S0 data: ${s0Error.message}`);
                        }
                    }
                    
                    // If LS130 or LS140, also get gas data
                    if (["LS130", "LS140"].includes(node.model)) {
                        try {
                            const gasResponse = await axios.get(`${baseUrl}/agas`, createRequestConfig());
                            if (gasResponse.data) {
                                meterData.gas = {
                                    counter: parseFloat(gasResponse.data.cnt || 0),
                                    flow: parseFloat(gasResponse.data.grate || 0)
                                };
                            }
                        } catch (gasError) {
                            node.warn(`Error getting gas data: ${gasError.message}`);
                        }
                    }
                    
                    // If LS140, also get water data
                    if (node.model === "LS140") {
                        try {
                            const waterResponse = await axios.get(`${baseUrl}/awater`, createRequestConfig());
                            if (waterResponse.data) {
                                meterData.water = {
                                    counter: parseFloat(waterResponse.data.cnt || 0),
                                    flow: parseFloat(waterResponse.data.wrate || 0)
                                };
                            }
                        } catch (waterError) {
                            node.warn(`Error getting water data: ${waterError.message}`);
                        }
                    }
                    
                    // Reset error count on success
                    errorCount = 0;
                    node.status({fill: "green", shape: "dot", text: `${meterData.power} W`});
                    
                    // Send message with the data
                    node.send({
                        topic: "youless",
                        payload: meterData
                    });
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
        if (config.startAutomatically !== false) {
            startPolling();
        }

        // Clean up on node removal or redeploy
        node.on('close', function() {
            stopPolling();
        });
    }

    RED.nodes.registerType("youless", YoulessNode);
    
    // Node configuration in the admin UI
    RED.httpAdmin.get("/youless/models", function(req, res) {
        const models = [
            { value: "LS110", label: "LS110 (Electricity only)" },
            { value: "LS120", label: "LS120 (Electricity + S0)" },
            { value: "LS130", label: "LS130 (Electricity + S0 + Gas)" },
            { value: "LS140", label: "LS140 (Electricity + S0 + Gas + Water)" }
        ];
        res.json(models);
    });
};
