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

  // Copy-to-clipboard buttons (used by the install pages' command boxes)
  document.querySelectorAll('.copy-cmd button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var code = btn.parentElement.querySelector('code');
      if (!code || !navigator.clipboard) return;
      navigator.clipboard.writeText(code.textContent || '').then(function () {
        var prev = btn.textContent;
        btn.textContent = 'Copied';
        btn.classList.add('copied');
        setTimeout(function () {
          btn.textContent = prev;
          btn.classList.remove('copied');
        }, 1600);
      }).catch(function (e) { console.warn('Copy failed:', e); });
    });
  });

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
