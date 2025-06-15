require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const mqtt = require("mqtt");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const morgan = require("morgan");
const swaggerUi = require("swagger-ui-express");
const swaggerJsDoc = require("swagger-jsdoc");
const Joi = require("joi");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(helmet());
app.use(morgan("combined"));

// ✅ Limiteur de requêtes sauf /energy/all
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: "🚫 تم تجاوز الحد الأقصى للطلبات. يرجى المحاولة لاحقًا.",
});
app.use((req, res, next) => {
  if (req.path === "/energy/all") return next();
  else limiter(req, res, next);
});

// Connexion MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("💾 تم الاتصال بقاعدة بيانات MongoDB"))
  .catch((err) => console.error("❌ خطأ في الاتصال بقاعدة البيانات:", err));

// Schéma Mongoose
const EnergySchema = new mongoose.Schema({
  temperature: Number,
  humidity: Number,
  voltage: Number,
  current_20A: Number,
  current_30A: Number,
  sct013: Number,
  waterFlow: Number,
  gasDetected: Number,
  level: Number,
  puissance: Number,
  delayMs: Number,
  timestamp: { type: Date, default: Date.now },
});
const EnergyModel = mongoose.model("Energy", EnergySchema);

// Connexion MQTT
const mqttClient = mqtt.connect(process.env.MQTT_BROKER);
mqttClient.on("connect", () => {
  console.log("🔗 تم الاتصال بخادم MQTT");
  mqttClient.subscribe("maison/energie", (err) => {
    if (err) console.error("❌ فشل الاشتراك في MQTT:", err);
  });
});
mqttClient.on("message", async (topic, message) => {
  try {
    const data = JSON.parse(message.toString());
    const timestamp = new Date(data.timestamp ?? Date.now());
    if (isNaN(timestamp.getTime())) throw new Error("تاريخ غير صالح");

    const delayMs = Date.now() - timestamp.getTime();
    const puissance = (data.sct013 ?? 0) * (data.voltage ?? 0);

    const newEntry = new EnergyModel({
      ...data,
      puissance,
      delayMs,
      timestamp,
    });

    await newEntry.save();
    console.log("✅ بيانات MQTT محفوظة. تأخير:", delayMs + "ms");
  } catch (error) {
    console.error("⚠️ خطأ أثناء معالجة رسالة MQTT:", error.message);
  }
});

// ✅ Chatbot avec prédiction + alerte gaz
app.post("/chatbot", async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: "يرجى إرسال سؤال." });

  try {
    const latestData = await EnergyModel.findOne().sort({ timestamp: -1 });

    let stats = "Aucune donnée récente disponible.";
    let alertMessage = "";

    if (latestData) {
      const {
        temperature,
        humidity,
        voltage,
        puissance,
        waterFlow,
        gasDetected,
      } = latestData;

      stats = `📊 Dernières données :
Température : ${temperature} °C
Humidité : ${humidity} %
Tension : ${voltage} V
Puissance : ${puissance} W
Débit d'eau : ${waterFlow} L/min
Gaz détecté : ${gasDetected} ppm`;

      if (gasDetected > 3000) {
        alertMessage = "🚨 *Niveau de danger : Gaz détecté > 3000 ppm !*";
      } else if (gasDetected > 1000) {
        alertMessage = "⚠️ *Niveau d'attention : Gaz entre 1000 et 3000 ppm.*";
      } else {
        alertMessage = "✅ *Niveau de sécurité : Gaz < 1000 ppm.*";
      }
    }

    const response = await axios.post(
      "https://api.deepseek.com/v1/chat/completions",
      {
        model: "deepseek-chat",
        messages: [
          {
            role: "system",
            content: `
You are a smart assistant who provides personalized and practical energy-saving tips for electricity, water, and gas.
Always reply in the same language as the user question:
- If the user writes in Arabic, reply in Arabic.
- If in French, reply in French.
- If in English, reply in English.
Be clear and direct.`,
          },
          {
            role: "user",
            content: `${alertMessage}\n\n${stats}\n\n${question}`,
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const answer = response.data.choices[0].message.content;
    res.json({ answer });
  } catch (err) {
    console.error("❌ خطأ DeepSeek:", err.message);
    res.status(500).json({ answer: "عذرًا، حدث خطأ أثناء معالجة سؤالك." });
  }
});

// Récupération des données récentes
app.get("/energy", async (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 1;
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const data = await EnergyModel.find({ timestamp: { $gte: since } })
      .sort({ timestamp: -1 })
      .limit(200);

    res.json(data);
  } catch (error) {
    console.error("❌ خطأ في جلب البيانات:", error);
    res.status(500).json({ error: "❌ خطأ في جلب البيانات." });
  }
});

// Toutes les données (limité à 50)
app.get("/energy/all", async (req, res) => {
  try {
    const data = await EnergyModel.find()
      .sort({ timestamp: -1 })
      .limit(50);

    res.json(data);
  } catch (error) {
    console.error("❌ خطأ في جلب جميع البيانات:", error);
    res.status(500).json({ error: "❌ خطأ في جلب جميع البيانات." });
  }
});

// Ajout manuel
app.post("/energy", async (req, res) => {
  const schema = Joi.object({
    temperature: Joi.number(),
    humidity: Joi.number(),
    voltage: Joi.number(),
    current_20A: Joi.number(),
    current_30A: Joi.number(),
    sct013: Joi.number(),
    waterFlow: Joi.number(),
    gasDetected: Joi.number(),
    level: Joi.number(),
  });

  const { error } = schema.validate(req.body);
  if (error) return res.status(400).send(error.details[0].message);

  try {
    const newData = new EnergyModel(req.body);
    await newData.save();
    res.status(201).json({ message: "📊 تم حفظ البيانات بنجاح!" });
  } catch (err) {
    res.status(500).json({ error: "❌ خطأ أثناء الحفظ." });
  }
});

// Swagger Docs
const swaggerOptions = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "API إدارة الطاقة وكشف الغاز",
      version: "1.0.0",
      description: "API لجمع بيانات استهلاك الطاقة والمياه وكشف الغاز",
    },
    servers: [{ url: `http://localhost:${PORT}` }],
  },
  apis: ["server.js"],
};
const swaggerDocs = swaggerJsDoc(swaggerOptions);
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDocs));

// Route de test
app.get("/", (req, res) => {
  res.send("🚀 الخادم يعمل!");
});

// Lancement du serveur
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 الخادم يعمل على http://0.0.0.0:${PORT}`);
});
