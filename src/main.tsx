import React from "react";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import "./styles/global.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("No se encuentra el contenedor principal de la aplicación.");
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
