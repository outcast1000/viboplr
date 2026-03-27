use image::{ImageBuffer, Rgba, imageops};
use std::path::{Path, PathBuf};

/// Generate a composite tag image from 1-3 artist images as overlapping circles.
/// Saves the result as PNG at `dest_path`.
pub fn generate_tag_composite(
    artist_image_paths: &[PathBuf],
    dest_path: &Path,
    canvas_size: u32,
) -> Result<(), String> {
    if artist_image_paths.is_empty() {
        return Err("No artist images provided".to_string());
    }

    let count = artist_image_paths.len().min(3);
    let cs = canvas_size as f64;

    // Determine circle diameter and positions based on count
    let (diameter, positions): (f64, Vec<(f64, f64)>) = match count {
        1 => {
            let d = cs * 0.75;
            let cx = (cs - d) / 2.0;
            let cy = (cs - d) / 2.0;
            (d, vec![(cx, cy)])
        }
        2 => {
            let d = cs * 0.65;
            let cy = (cs - d) / 2.0;
            let overlap = d * 0.30;
            let total_w = d * 2.0 - overlap;
            let x0 = (cs - total_w) / 2.0;
            (d, vec![(x0, cy), (x0 + d - overlap, cy)])
        }
        _ => {
            let d = cs * 0.55;
            let cy = (cs - d) / 2.0;
            let overlap = d * 0.30;
            let total_w = d * 3.0 - overlap * 2.0;
            let x0 = (cs - total_w) / 2.0;
            (d, vec![
                (x0, cy),
                (x0 + d - overlap, cy),
                (x0 + 2.0 * (d - overlap), cy),
            ])
        }
    };

    let diameter_u32 = diameter.round() as u32;
    let radius = diameter / 2.0;

    // Create transparent canvas
    let mut canvas: ImageBuffer<Rgba<u8>, Vec<u8>> =
        ImageBuffer::from_pixel(canvas_size, canvas_size, Rgba([0, 0, 0, 0]));

    // Draw circles right-to-left so the first artist (highest track count) is on top
    for i in (0..count).rev() {
        let img = image::open(&artist_image_paths[i])
            .map_err(|e| format!("Failed to open {}: {}", artist_image_paths[i].display(), e))?;

        // Resize to circle diameter, cropping to square first
        let img = img.resize_to_fill(diameter_u32, diameter_u32, imageops::FilterType::Lanczos3);
        let mut rgba = img.to_rgba8();

        // Apply circular mask with anti-aliasing
        let border_width = 2.0_f64;
        let border_color = Rgba([30, 30, 30, 200]);
        for y in 0..diameter_u32 {
            for x in 0..diameter_u32 {
                let dx = x as f64 + 0.5 - radius;
                let dy = y as f64 + 0.5 - radius;
                let dist = (dx * dx + dy * dy).sqrt();

                if dist > radius {
                    // Outside circle — transparent
                    rgba.put_pixel(x, y, Rgba([0, 0, 0, 0]));
                } else if dist > radius - 1.0 {
                    // Anti-alias edge
                    let alpha = (radius - dist).clamp(0.0, 1.0);
                    let p = rgba.get_pixel(x, y);
                    let a = (p[3] as f64 * alpha) as u8;
                    rgba.put_pixel(x, y, Rgba([p[0], p[1], p[2], a]));
                } else if dist > radius - 1.0 - border_width {
                    // Border ring
                    let blend = ((radius - 1.0 - dist) / border_width).clamp(0.0, 1.0);
                    let p = rgba.get_pixel(x, y);
                    let r = lerp_u8(p[0], border_color[0], blend);
                    let g = lerp_u8(p[1], border_color[1], blend);
                    let b = lerp_u8(p[2], border_color[2], blend);
                    let a = lerp_u8(p[3], border_color[3].max(p[3]), blend);
                    rgba.put_pixel(x, y, Rgba([r, g, b, a]));
                }
            }
        }

        // Overlay onto canvas
        let px = positions[i].0.round() as i64;
        let py = positions[i].1.round() as i64;
        imageops::overlay(&mut canvas, &rgba, px, py);
    }

    // Ensure parent directory exists
    if let Some(parent) = dest_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {}", e))?;
    }

    canvas
        .save(dest_path)
        .map_err(|e| format!("Failed to save composite: {}", e))?;

    Ok(())
}

fn lerp_u8(a: u8, b: u8, t: f64) -> u8 {
    (a as f64 * (1.0 - t) + b as f64 * t).round() as u8
}
