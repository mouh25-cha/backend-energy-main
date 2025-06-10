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

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(helmet());
app.use(morgan("combined"));

// Rate limiter
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: "🚫 تم تجاوز الحد الأقصى للطلبات. يرجى المحاولة لاحقًا.",
});
app.use(limiter);

// Connexion MongoDB (sans options obsolètes)
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("💾 تم الاتصال بقاعدة بيانات MongoDB"))
  .catch((err) => console.error("❌ خطأ في الاتصال بقاعدة البيانات:", err));

// Modèle de données
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

// Chatbot IA multilingue
app.post("/chatbot", async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: "يرجى إرسال سؤال." });

  const q = question.toLowerCase();
  let answer = "عذرًا، لم أفهم السؤال.";

  const match = (keywords) => keywords.some((k) => q.includes(k));

  if (match(["طاقة", "كهرب", "الطاقة", "استهلاك"])) {
    answer = "استخدم الأجهزة بكفاءة، وأطفئها عند عدم الحاجة.";
  } else if (match(["توفير", "اقتصاد", "خفض", "تقليل", "فاتورة"])) {
    answer = "غيّر لمباتك إلى LED، ولا تترك الأجهزة في وضع الاستعداد.";
  } else if (match(["énergie", "électrique", "électricité", "consommation"])) {
    answer = "Utilisez les appareils efficacement et éteignez-les lorsqu'ils ne sont pas nécessaires.";
  } else if (match(["économiser", "réduire", "baisser", "facture", "économie"])) {
    answer = "Remplacez vos ampoules par des LED et évitez de laisser les appareils en veille.";
  } else if (match(["energy", "electricity", "power", "consumption"])) {
    answer = "Use devices efficiently and turn them off when not needed.";
  } else if (match(["save", "reduce", "lower", "bill", "economy"])) {
    answer = "Switch to LED bulbs and avoid leaving devices on standby.";
  }

  res.json({ answer });
});

// Test serveur
app.get("/", (req, res) => {
  res.send("🚀 الخادم يعمل!");
});

// Récupération des données
app.get("/energy", async (req, res) => {
  try {
    const data = await EnergyModel.find().sort({ timestamp: -1 }).limit(2000);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: "❌ خطأ في جلب البيانات." });
  }
});

// Ajout manuel de données (via POST)
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

// Swagger API doc
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

// Démarrage serveur
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 الخادم يعمل على http://0.0.0.0:${PORT}`);
});
