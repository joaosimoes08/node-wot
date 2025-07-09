const { Servient } = require("@node-wot/core");
const { HttpServer } = require("@node-wot/binding-http");
const { CoapServer } = require("@node-wot/binding-coap");
const { MqttBrokerServer, MqttClientFactory } = require("@node-wot/binding-mqtt");
const { MongoClient } = require("mongodb");
const OpenAI = require('openai');
require("dotenv").config();

const openai = new OpenAI();

const servient = new Servient();
servient.addServer(new HttpServer());
servient.addServer(new MqttBrokerServer({ uri: "mqtt://test.mosquitto.org" }));
servient.addClientFactory(new MqttClientFactory());

const client = new MongoClient(process.env.MONGO_URI);

let sensorData = {};

servient.start().then( async (WoT) => {
    await client.connect();
    const db = client.db(process.env.DB_NAME);
    const thingsCollection = db.collection("TDs");
    const locationCollection = db.collection("sensorLocation");
    const sensorDataCollection = db.collection("sensorsData");

    const storedThings = await thingsCollection.find({}).toArray();

    for (const { title, thing} of storedThings) {
        const producedThing = await WoT.produce(thing);
        if (title.startsWith("Buffet-Food-Quality-Analyzer")) {
            bindAnalyzerHandlers(producedThing, sensorDataCollection, locationCollection);
        } else if (title.startsWith("Buffet-Food-Quality-Cam")) {
            bindCamHandlers(producedThing)
        } else {
            console.warn(`Unknown thing title: ${title}`);
        }
        await producedThing.expose();
        console.log("Buffet-Food-Quality-Analyzer Thing is exposed.");
    }


});

async function bindAnalyzerHandlers(thing, datacollection, locationcollection) {
    const thingId = thing.id;
    const validIds = ["temperature", "humidity", "co2", "tvoc"];

    const doc2 = await locationcollection.findOne({ _id: thingId }); //ler dados de localizacao dos sensores
    let location = doc2?.data?.location?.value ?? "Unknown";
    console.log(`[INIT] ${thingId} → sensorData initialized`, sensorData);

    thing.setPropertyReadHandler("allSensorData", async () => sensorData);
    thing.setPropertyReadHandler("currentSensorData", async () => {
        const id = thing.id; // ou const id = thing.id;

        try {
            const res = await fetch(`http://192.168.137.100/api/last-reading`);

            if (!res.ok) {
                throw new Error(`HTTP error! status: ${res.status}`);
            }

            const data = await res.json();
            const now = new Date();

            const sensorId = "wot:dev:" + id;
            const deviceType = thing.title;

            // Atualiza sensorData
            sensorData[id] = {
                temperature: data.temperature,
                humidity: data.humidity,
                co2: data.co2,
                tvoc: data.tvoc,
                timestamp: now
            };

            console.log(`Atualizado ${id}:`, sensorData[id]);

            // Atualiza documento na base de dados
            await datacollection.updateOne(
                { _id: thingId },
                {
                    $set: {
                        sensorId: sensorId,
                        deviceType: deviceType,
                        temperature: data.temperature,
                        humidity: data.humidity,
                        co2: data.co2,
                        tvoc: data.tvoc,
                        timestamp: now.toISOString()
                    }
                },
                { upsert: true }
            );

            return {
                id,
                temperature: data.temperature,
                humidity: data.humidity,
                co2: data.co2,
                tvoc: data.tvoc,
                timestamp: now.toISOString()
            };

        } catch (error) {
            console.error("Error fetching current sensor data:", error);
            throw new Error("Failed to fetch current sensor data.");
        }
    });

    thing.setPropertyWriteHandler("sensorDataReceived", async (val, options) => {
        const id = thing.id
        console.log("🔥 writeproperty MQTT chamado!");
        try {
            const payload = await val.value();
            console.log("[DEBUG] Payload recebido:", payload);

            const { sensorId, temperature, humidity, co2, tvoc } = payload || {};

            console.log(payload)

            if (!sensorId) {
                console.error("[ERROR] sensorId ausente.");
                throw new Error("Parâmetro 'sensorId' em falta.");
            }

            if ([temperature, humidity, co2, tvoc].some(val => typeof val === 'undefined')) {
                console.error("[ERROR] Uma ou mais métricas ausentes:", { temperature, humidity, co2, tvoc });
                throw new Error("Faltam métricas no payload.");
            }

            const document = {
                sensorId,
                deviceType: thing.title || 'Buffet-Food-Quality-Analyzer',
                temperature,
                humidity,
                co2,
                tvoc,
                timestamp: new Date()
            };

            sensorData[id] = {
                temperature: payload.temperature,
                humidity: payload.humidity,
                co2: payload.co2,
                tvoc: payload.tvoc,
                timestamp: new Date()
            };

            console.log("[DEBUG] Documento a inserir:", document);

            // Conexão com o Mongo (certifique-se que está definida corretamente)
            thing.emitEvent("humidityAlert", `Hello World.`);
            await datacollection.insertOne(document);

            console.log("✅ Dados do sensor inseridos com sucesso!");
        } catch (error) {
            console.error("[Erro ao inserir dados do sensor via WoT]", error);
            throw new Error("Erro ao processar os dados do sensor.");
        }
    });



    thing.setPropertyReadHandler("sensorDataReceived", async () => {
            // Check if uriVariables are provided
        return sensorData;
    });
    thing.setPropertyReadHandler("sensorStatus", async (options) => {
        // Check if uriVariables are provided
        if (options && typeof options === "object" && "uriVariables" in options) {
            const uriVariables = options.uriVariables;
            let rand_number = Math.floor(Math.random() * 2);
            if ("id" in uriVariables) {
                const id = uriVariables.id;
                if (rand_number === 0) {
                    return "The Sensor " + id + " is ok";
                } else {
                    return "The Sensor " + id + " is failing";
                }
            }
        }
        throw Error("Please specify id variable as uriVariables.");
    });
    thing.setPropertyReadHandler("motorStatus", async () => {
        let rand_number = Math.floor(Math.random() * 2);
        if (rand_number === 0) {
            return "The motor is ok";
        } else {
            return "The motor is failing";
        }
    });
    thing.setPropertyReadHandler("location", async () => {
        console.log(`Reading location for ${thingId}:`, location);
        return location;
    });
    thing.setPropertyWriteHandler("location", async (val) => {
        location = await val.value();
        console.log(`Location updated to:`, location);
        await locationcollection.updateOne(
            { _id: thingId },
            {
                $set: {
                    "data.location.value": location,
                    "data.location.lastModified": new Date(),
                    deviceType: thing.title
                }
            },
            { upsert: true }
        );
    });
    thing.setActionHandler("closeBuffet", async () => {
        try {
            const response = await fetch("http://192.168.137.100/api/toggle-on", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                // If the API expects any body, add it here. If not, omit this.
                body: JSON.stringify({}) 
            });

            if (!response.ok) {
                throw new Error(`Request failed with status ${response.status}`);
            }

            return {
                result: true,
                message: "Buffet closed successfully and POST request sent.",
            };
        } catch (error) {
            console.error("Error during POST request:", error);
            return {
                result: false,
                message: `Failed to close buffet: ${error.message}`,
            };
        }
    });

    thing.setActionHandler("openBuffet", async () => {
        try {
            const response = await fetch("http://192.168.137.100/api/toggle-off", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                // If the API expects any body, add it here. If not, omit this.
                body: JSON.stringify({}) 
            });

            if (!response.ok) {
                throw new Error(`Request failed with status ${response.status}`);
            }

            return {
                result: true,
                message: "Buffet opened successfully and POST request sent.",
            };
        } catch (error) {
            console.error("Error during POST request:", error);
            return {
                result: false,
                message: `Failed to open buffet: ${error.message}`,
            };
        }
    });
}

async function bindCamHandlers(thing) {
    var pic = false;

    const fs = require("fs");
    const path = require("path");

thing.setPropertyWriteHandler("photo", async (val) => {
    try {
        const base64Image = await val.value();

        const answer = await GPT_Veredict(
            sensorData.co2,
            sensorData.temperature,
            sensorData.tvoc,
            base64Image
        );

        console.log("🤖 Resposta da IA:", answer);

        if (!answer) {
            console.error("❌ Erro: A resposta da IA foi vazia ou indefinida.");
            return;
        }

        if (answer.toLowerCase() === "yes") {
            console.log("Alimento em bom estado");
        } else {
            thing.emitEvent("badFood", `Remove the food from the tray NOW!`);
            fetch("http://192.168.137.248:8080/buffet-food-quality-analyzer-01/actions/closeBuffet", {
                method: "POST"
            });
        }
    } catch (err) {
        console.error("❌ Erro no writeHandler de 'photo':", err);
    }
});


}
async function GPT_Veredict(ppm, tvoc, temp, base64Image) {
  try {
    const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
        {
        role: "user",
        content: [
            {
            type: "text",
            text: `
    The raw food in a buffet has the following sensor readings:
    - CO2: ${ppm} ppm
    - VOC: ${tvoc} ppb
    - Temperature: ${temp}°C

    Based solely on these values and the image provided, is the food safe to consume?

    Reply only with "Yes" or "No" — no explanations or other text.
            `,
            },
            {
            type: "image_url",
            image_url: {
                url: `data:image/jpeg;base64,${base64Image}`,
            },
            },
        ],
        },
    ],
    max_tokens: 5,
    });

    
    //console.log("Resposta completa da API:", JSON.stringify(response, null, 2));

    if (response) {
      const verdict = response.choices[0].message.content.trim();
      console.log("GPT verdict:", verdict);
      return verdict;
    } else {
        console.log("Error");
      //console.error("Estrutura da resposta inesperada:", response);
      return null;
    }
  } catch (err) {
    console.error("Erro na função GPT_Veredict:", err);
    throw err;
  }
}