<?php

namespace App;

use App\Models\{User};
use Symfony\Component\HttpFoundation\Response;

class Api
{
    public function respond(User $user): Response
    {
        return new Response();
    }
}
