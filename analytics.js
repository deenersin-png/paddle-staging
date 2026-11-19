// Google Analytics (gtag.js) for this site.
// Each site keeps its own copy of this file with its own GA id
// (septa-scheduler and paddleapp.github.io differ). The mirror workflow
// never copies this file to paddleapp.github.io.
// Loaded without async so gtag() exists before page scripts call it.
(function () {
  var GA_ID = 'G-QXEKGF4DXT';
  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
  document.head.appendChild(s);
  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { dataLayer.push(arguments); };
  gtag('js', new Date());
  gtag('config', GA_ID);
})();
