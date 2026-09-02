/**
 * Image validation utilities for camera module
 */

/**
 * Check if a buffer contains a valid JPEG image
 * @param {Buffer} buffer - Image buffer to validate
 * @returns {boolean} True if buffer starts with JPEG magic bytes (0xFF 0xD8)
 */
function isValidJpeg(buffer) {
    if (!buffer || buffer.length < 2) return false;
    return buffer[0] === 0xFF && buffer[1] === 0xD8;
}

/**
 * Check if a JPEG has valid internal structure
 * Validates that bytes 2-3 contain a valid JPEG marker
 * @param {Buffer} buffer - Image buffer to validate
 * @returns {boolean} True if JPEG has valid structure
 */
function hasValidJpegStructure(buffer) {
    if (!buffer || buffer.length < 4) return false;
    
    return (
        (buffer[2] === 0xFF && buffer[3] === 0xE0) ||  // JFIF marker
        (buffer[2] === 0xFF && buffer[3] === 0xE1) ||  // EXIF marker
        (buffer[2] === 0xFF && buffer[3] === 0xDB) ||  // Quantization table
        (buffer[2] === 0xFF && buffer[3] === 0xC0) ||  // Start of frame
        (buffer[2] === 0xFF && buffer[3] === 0xC4)     // Huffman table
    );
}

/**
 * Validate an image buffer with multiple checks
 * @param {Buffer} buffer - Image buffer to validate
 * @param {Object} options - Validation options
 * @param {number} [options.minSize=100] - Minimum acceptable size in bytes
 * @param {boolean} [options.checkStructure=true] - Whether to check JPEG structure
 * @returns {Object} Validation result with isValid flag and error message if invalid
 */
function validateImageBuffer(buffer, options = {}) {
    const { minSize = 100, checkStructure = true } = options;
    
    if (!buffer || buffer.length === 0) {
        return { isValid: false, error: 'Empty image buffer' };
    }
    
    if (buffer.length < minSize) {
        return { isValid: false, error: `Image too small (${buffer.length} bytes)` };
    }
    
    if (!isValidJpeg(buffer)) {
        return { isValid: false, error: 'Invalid JPEG format' };
    }
    
    if (checkStructure && !hasValidJpegStructure(buffer)) {
        return { isValid: false, error: 'JPEG with invalid structure' };
    }
    
    return { isValid: true };
}

/**
 * Convert image format string to MIME type
 * @param {string} format - Image format (jpg, jpeg, png, bmp)
 * @returns {string} MIME type string
 */
function formatToMime(format) {
    const fmt = String(format || "").toLowerCase();
    if (fmt === "jpg" || fmt === "jpeg") return "image/jpeg";
    if (fmt === "png") return "image/png";
    if (fmt === "bmp") return "image/bmp";
    return "application/octet-stream";
}

module.exports = {
    isValidJpeg,
    hasValidJpegStructure,
    validateImageBuffer,
    formatToMime
};
