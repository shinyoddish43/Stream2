<?php
/**
 * Optional configuration. Copy to config.php to use it.
 *
 * The only setting here is where the studio keeps its data. The default is the
 * data/ directory inside the app, which ships with an .htaccess that denies
 * access — that is enough on Apache (cPanel, Plesk, DirectAdmin).
 *
 * On nginx, or anywhere .htaccess is ignored, move the data above the web root
 * instead. Use an absolute path the PHP user can write to:
 */

// define('STUDIO_DATA_DIR', '/home/USER/stream-studio-data');
