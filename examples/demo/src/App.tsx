import { DatasetContext } from "@designbookapp/designbook/config";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AppHeader } from "./components/AppHeader";
import { datasets } from "./data/products";
import { AboutPage } from "./pages/AboutPage";
import { HomePage } from "./pages/HomePage";
import { TripDetailPage } from "./pages/TripDetailPage";
import { TripsPage } from "./pages/TripsPage";
import { LanguageProvider } from "./providers/LanguageProvider";
import { ThemeProvider } from "./providers/ThemeProvider";

function App() {
  return (
    <ThemeProvider>
      <LanguageProvider>
        <DatasetContext value={datasets[0]}>
          <BrowserRouter>
            <AppHeader />
            <main className="mx-auto max-w-5xl p-8">
              <Routes>
                <Route path="/" element={<HomePage />} />
                <Route path="/trips" element={<TripsPage />} />
                <Route path="/trips/:id" element={<TripDetailPage />} />
                <Route path="/about" element={<AboutPage />} />
              </Routes>
            </main>
          </BrowserRouter>
        </DatasetContext>
      </LanguageProvider>
    </ThemeProvider>
  );
}

export { App };
