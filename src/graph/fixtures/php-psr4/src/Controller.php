<?php

namespace App;

use App\Models\User;
use App\Missing\Ghost;
use App\Contracts\HasName as Named;
use function App\Helpers\format_name;

class Controller
{
    public function show(User $user): string
    {
        return format_name($user->name);
    }
}
