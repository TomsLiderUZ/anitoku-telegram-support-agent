import theme from "@theme";
import AppLink from "../../components/AppLink";

function TestPage() {
  return (
    <section>
      <button type="button" onClick={() => theme.set({ mode: "light" })}>Light</button>
      <button type="button" onClick={() => theme.set({ mode: "dark" })}>Dark</button>
      <button type="button" onClick={() => theme.set({ mode: "auto" })}>Auto</button>
      <br />
      <AppLink to="/dashboard">
        Page
      </AppLink>
    </section>
  );
}

export default TestPage;
