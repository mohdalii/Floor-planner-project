import mongoose from "mongoose";

const roomSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    type: { type: String, required: true },
    roomIndex: { type: Number, required: true },
    box: {
      cx: Number,
      cy: Number,
      w: Number,
      h: Number,
    },
  },
  { _id: false }
);

const planSchema = new mongoose.Schema(
  {
    requirements: {
      bedrooms: Number,
      bathrooms: Number,
      kitchens: Number,
      livingRooms: Number,
      balconies: Number,
      storages: Number,
    },
    rooms: [roomSchema],
    plot: {
      widthM: Number,
      depthM: Number,
      areaM2: Number,
      expanded: Boolean,
    },
    validation: {
      passed: Boolean,
      checks: mongoose.Schema.Types.Mixed,
    },
    costEstimate: {
      totalCost: Number,
      currency: String,
      breakdown: mongoose.Schema.Types.Mixed,
      assumptions: [String],
    },
  },
  { timestamps: true }
);

export const Plan = mongoose.model("Plan", planSchema);
