// Serves site/dist at https://theaipipe.com/kiosk-payments/ (route theaipipe.com/kiosk-payments*).
// Static files only; nothing here talks to a database or a payment service.
export default {
  fetch(request, env) {
    return env.ASSETS.fetch(request);
  },
};
