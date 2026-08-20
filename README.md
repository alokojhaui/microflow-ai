<p align="center">
  <img src="./assets/hero.svg" alt="Microflow AI Animated Banner" width="100%" />
</p>

<h1 align="center">Microflow AI 🧬🔬</h1>

<p align="center">
  <strong>AI-Powered Organ-on-Chip Microfluidic Assay Simulator</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB" alt="React" />
  <img src="https://img.shields.io/badge/Vite-B73BFE?style=for-the-badge&logo=vite&logoColor=FFD62E" alt="Vite" />
  <img src="https://img.shields.io/badge/Vercel-000000?style=for-the-badge&logo=vercel&logoColor=white" alt="Vercel" />
  <img src="https://img.shields.io/badge/Gemini_AI-4285F4?style=for-the-badge&logo=google&logoColor=white" alt="Gemini AI" />
</p>

<hr />

## 🚀 Overview

**Microflow AI** is a state-of-the-art simulation platform for evaluating drug dose-response curves through virtual **Organ-on-Chip (OoC)** microfluidic networks. It combines high-throughput structural layouts with the power of **Google's Gemini AI** to interpret viability metrics, morphology scores, and toxicity risks in real-time.

## ✨ Key Features

- 🧪 **Dynamic Chip Simulations:** Visualize fluidic mixing across 5 distinct microfluidic chip paradigms:
  - *Smooth Serpentine:* Long-path advection/diffusion mixing.
  - *Linear Manifold:* High-throughput structural bus.
  - *Radial Hub:* Centrifugal fluidics vortex.
  - *Christmas Tree:* Successive Whitesides splitting.
  - *Legacy Serpentine:* Classic orthogonal-channel model.
- 🤖 **Gemini AI Integration:** Generates advanced biological readouts based on computed Hill Curve fits, toxicity, and morphology scores.
- 📈 **Real-time Dose-Response:** Interactively titrate low/high doses across a 6-point concentration scale and instantly view non-linear regression curves.
- 🎨 **Sleek UI:** Dark-mode optimized, scientific data dashboard with compound history tracking and dynamic SVGs.

## 🛠️ Quick Start

Clone the repository and install dependencies:

```bash
git clone https://github.com/alokojhaui/microflow-ai.git
cd microflow-ai
npm install
npm run dev
```

Ensure you add your Google Gemini API key via the app's secure key panel before running AI analyses.

## 🧪 Simulation Specs

Each simulation maps a standardized 6-point logarithmic gradient to physical nodes on our virtual chips. While physical designs dictate fluidic resistance and advective mixing efficiency in reality, **Microflow AI normalizes the concentration gradient** output to allow for 1-to-1 biological comparisons across all geometries.

---
<p align="center"><i>Simulate Smarter. Discover Faster.</i></p>
