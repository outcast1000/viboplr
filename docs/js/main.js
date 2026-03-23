// Viboplr Website — Minimal JS

(function () {
  'use strict';

  // Mobile nav toggle
  var hamburger = document.getElementById('navHamburger');
  var navLinks = document.getElementById('navLinks');

  if (hamburger && navLinks) {
    hamburger.addEventListener('click', function () {
      hamburger.classList.toggle('open');
      navLinks.classList.toggle('open');
    });

    // Close nav when a link is clicked
    navLinks.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', function () {
        hamburger.classList.remove('open');
        navLinks.classList.remove('open');
      });
    });
  }

  // Smooth scroll for anchor links
  document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
    anchor.addEventListener('click', function (e) {
      var targetId = this.getAttribute('href');
      if (!targetId || targetId === '#' || !targetId.startsWith('#')) return;
      var target = document.querySelector(targetId);
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

  // Fetch latest version and download URLs from GitHub Releases API
  fetch('https://api.github.com/repos/outcast1000/viboplr/releases/latest')
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (!data || !data.tag_name) return;

      // Set version badges
      document.querySelectorAll('#version-badge').forEach(function (el) {
        el.textContent = data.tag_name;
      });

      // Find download URLs from release assets
      var dmgUrl = '';
      var msiUrl = '';
      (data.assets || []).forEach(function (asset) {
        if (asset.browser_download_url) {
          if (asset.name.endsWith('.dmg')) dmgUrl = asset.browser_download_url;
          if (asset.name.endsWith('.msi')) msiUrl = asset.browser_download_url;
        }
      });

      // Update all macOS download links
      if (dmgUrl) {
        document.querySelectorAll('a[href$="#download-macos"]').forEach(function (el) {
          el.href = dmgUrl;
        });
      }

      // Update all Windows download links
      if (msiUrl) {
        document.querySelectorAll('a[href$="#download-windows"]').forEach(function (el) {
          el.href = msiUrl;
        });
      }
    })
    .catch(function () { /* silently ignore */ });

  // Scroll-triggered reveal animations
  var reveals = document.querySelectorAll('.reveal');

  if (reveals.length > 0 && 'IntersectionObserver' in window) {
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15, rootMargin: '0px 0px -40px 0px' }
    );

    reveals.forEach(function (el) {
      observer.observe(el);
    });
  } else {
    // Fallback: show all immediately
    reveals.forEach(function (el) {
      el.classList.add('visible');
    });
  }
})();
