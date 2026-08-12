<?php

namespace App;

require __DIR__ . '/../vendor/autoload_stub/autoload.php';
require __DIR__ . '/../vendor/missing_package/autoload.php';

use Monolog\Logger;

class Bootstrap
{
    public function logger(): Logger
    {
        return new Logger('app');
    }
}
